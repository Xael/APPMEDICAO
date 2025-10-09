import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { queueRecord, addAfterPhotosToPending } from "./syncManager";
import logoSrc from './assets/Logo.png';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend } from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend);

// --- Tipos, Helpers, Hooks ---
const API_BASE = (import.meta as any).env?.VITE_API_BASE || '';
let API_TOKEN: string | null = localStorage.getItem('crbApiToken');

const setApiToken = (token: string | null) => {
    API_TOKEN = token;
    if (token) { localStorage.setItem('crbApiToken', token); }
    else { localStorage.removeItem('crbApiToken'); }
};

const apiFetch = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    if (API_TOKEN) { headers.append('Authorization', `Bearer ${API_TOKEN}`); }
    if (!(options.body instanceof FormData)) { headers.append('Content-Type', 'application/json'); }
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (!response.ok) {
        let errorBody;
        try { errorBody = await response.json(); }
        catch (e) { errorBody = await response.text(); }
        console.error("API Error:", errorBody);
        throw new Error(`API request failed with status ${response.status}`);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') { return null; }
    return response.json();
};

const dataURLtoFile = (dataurl: string, filename: string): File => {
    const arr = dataurl.split(','), mimeMatch = arr[0].match(/:(.*?);/);
    if (!mimeMatch) throw new Error("Invalid data URL");
    const mime = mimeMatch[1], bstr = atob(arr[1]); let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) { u8arr[n] = bstr.charCodeAt(n); }
    return new File([u8arr], filename, { type: mime });
};

type Role = 'ADMIN' | 'OPERATOR' | 'FISCAL';
type View =
    | 'LOGIN'
    | 'ADMIN_DASHBOARD'
    | 'ADMIN_MANAGE_SERVICES'
    | 'ADMIN_MANAGE_LOCATIONS'
    | 'ADMIN_MANAGE_USERS'
    | 'ADMIN_MANAGE_GOALS'
    | 'ADMIN_MANAGE_CYCLES'
    | 'ADMIN_EDIT_RECORD'
    | 'AUDIT_LOG'
    | 'FISCAL_DASHBOARD'
    | 'REPORTS'
    | 'HISTORY'
    | 'DETAIL'
    | 'OPERATOR_GROUP_SELECT'
    | 'OPERATOR_LOCATION_SELECT'
    | 'OPERATOR_SERVICE_SELECT'
    | 'PHOTO_STEP'
    | 'OPERATOR_SERVICE_IN_PROGRESS'
    | 'CONFIRM_STEP';

interface Unit { id: string; name: string; symbol: string; }
interface ServiceDefinition { id: string; name: string; unit: Unit; unitId: number; }
interface LocationServiceDetail { serviceId: string; name: string; measurement: number; unit: Unit; }
interface UserAssignment { contractGroup: string; serviceNames: string[]; }
interface User { id: string; username: string; email?: string; password?: string; role: Role; assignments?: UserAssignment[]; }
interface GeolocationCoords { latitude: number; longitude: number; }
interface LocationRecord { id: string; contractGroup: string; name: string; coords?: GeolocationCoords; services?: LocationServiceDetail[]; }
interface ServiceRecord { id: string; operatorId: string; operatorName: string; serviceType: string; serviceUnit: string; locationId?: string; locationName: string; contractGroup: string; locationArea?: number; gpsUsed: boolean; startTime: string; endTime: string; beforePhotos: string[]; afterPhotos: string[]; tempId?: string; }
interface Goal { id: string; contractGroup: string; month: string; targetArea: number; }
interface AuditLogEntry { id: string; timestamp: string; adminId: string; adminUsername: string; action: 'UPDATE' | 'DELETE'; recordId: string; details: string; }
interface ContractConfig { id: number; contractGroup: string; cycleStartDay: number; }

const formatDateTime = (isoString: string) => new Date(isoString).toLocaleString('pt-BR');
const calculateDistance = (p1: GeolocationCoords, p2: GeolocationCoords) => {
    if (!p1 || !p2) return Infinity;
    const R = 6371e3;
    const φ1 = p1.latitude * Math.PI / 180; const φ2 = p2.latitude * Math.PI / 180;
    const Δφ = (p2.latitude - p1.latitude) * Math.PI / 180; const Δλ = (p2.longitude - p1.longitude) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};
const useLocalStorage = <T,>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] => {
    const [storedValue, setStoredValue] = useState<T>(() => {
        try { const item = window.localStorage.getItem(key); return item ? JSON.parse(item) : initialValue; }
        catch (error) { return initialValue; }
    });
    const setValue: React.Dispatch<React.SetStateAction<T>> = (value) => {
        try {
            const valueToStore = value instanceof Function ? value(storedValue) : value;
            setStoredValue(valueToStore);
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (error) { console.error(error); }
    };
    return [storedValue, setValue];
};

// --- Componentes ---

const Header: React.FC<{ view: View; currentUser: User | null; onBack?: () => void; onLogout: () => void; }> = ({ view, currentUser, onBack, onLogout }) => {
    const isAdmin = currentUser?.role === 'ADMIN';
    const showBackButton = onBack && view !== 'LOGIN' && view !== 'ADMIN_DASHBOARD' && view !== 'FISCAL_DASHBOARD' && view !== 'OPERATOR_GROUP_SELECT';
    const showLogoutButton = currentUser;
    const getTitle = () => {
        if (!currentUser) return 'CRB SERVIÇOS';
        if (isAdmin) {
            switch (view) {
                case 'ADMIN_DASHBOARD': return 'Painel do Administrador';
                case 'ADMIN_MANAGE_SERVICES': return 'Gerenciar Tipos de Serviço';
                case 'ADMIN_MANAGE_LOCATIONS': return 'Gerenciar Locais';
                case 'ADMIN_MANAGE_USERS': return 'Gerenciar Funcionários';
                case 'ADMIN_MANAGE_GOALS': return '🎯 Metas & Gráficos';
                case 'ADMIN_MANAGE_CYCLES': return '🗓️ Gerenciar Ciclos de Medição';
                case 'REPORTS': return 'Gerador de Relatórios';
                case 'HISTORY': return 'Histórico Geral';
                case 'DETAIL': return 'Detalhes do Serviço';
                case 'ADMIN_EDIT_RECORD': return 'Editar Registro de Serviço';
                case 'AUDIT_LOG': return '📜 Log de Auditoria';
                default: return 'Modo Administrador';
            }
        }
        if (currentUser.role === 'FISCAL') {
            switch (view) {
                case 'FISCAL_DASHBOARD': return 'Painel de Fiscalização';
                case 'REPORTS': return 'Relatórios';
                case 'HISTORY': return 'Histórico de Serviços';
                case 'DETAIL': return 'Detalhes do Serviço';
                default: return 'Modo Fiscalização';
            }
        }
        switch (view) {
            case 'OPERATOR_GROUP_SELECT': return 'Selecione o Contrato/Cidade';
            case 'OPERATOR_LOCATION_SELECT': return 'Selecione o Local';
            case 'OPERATOR_SERVICE_SELECT': return `Selecione o Serviço`;
            case 'OPERATOR_SERVICE_IN_PROGRESS': return 'Serviço em Andamento';
            case 'HISTORY': return 'Meu Histórico';
            case 'DETAIL': return 'Detalhes do Serviço';
            case 'ADMIN_EDIT_RECORD': return 'Adicionar Fotos/Informações';
            default: return 'Registro de Serviço';
        }
    };
    return (
        <header className={isAdmin ? 'admin-header' : ''}>
            {showBackButton && <button className="button button-sm button-secondary header-back-button" onClick={onBack}>&lt; Voltar</button>}
            <div className="header-content">
                {view === 'LOGIN' && <img src={logoSrc} alt="Logo CRB Serviços" className="header-logo" />}
                <h1>{getTitle()}</h1>
            </div>
            {showLogoutButton && <button className="button button-sm button-danger header-logout-button" onClick={onLogout}>Sair</button>}
        </header>
    );
};

const Loader: React.FC<{ text?: string }> = ({ text = "Carregando..." }) => (<div className="loader-container"><div className="spinner"></div><p>{text}</p></div>);

const CameraView: React.FC<{ onCapture: (dataUrl: string) => void; onCancel: () => void; onFinish: () => void; photoCount: number }> = ({ onCapture, onCancel, onFinish, photoCount }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const cameraViewRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const elem = cameraViewRef.current;
        if (!elem) return;
        const enterFullscreen = async () => {
            try {
                if (document.fullscreenElement) return;
                if (elem.requestFullscreen) { await elem.requestFullscreen(); }
                if (screen.orientation && screen.orientation.lock) { await screen.orientation.lock('landscape'); }
            } catch (err) { console.warn("Não foi possível ativar tela cheia ou travar orientação:", err); }
        };
        enterFullscreen();
        return () => {
            try {
                if (document.fullscreenElement) { document.exitFullscreen(); }
                if (screen.orientation && screen.orientation.unlock) { screen.orientation.unlock(); }
            } catch (err) { console.warn("Não foi possível sair da tela cheia ou destravar orientação:", err); }
        };
    }, []);
    useEffect(() => {
        let mediaStream: MediaStream | null = null;
        let isMounted = true;
        navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } })
            .then(streamInstance => {
                if (isMounted) {
                    mediaStream = streamInstance;
                    if (videoRef.current) { videoRef.current.srcObject = streamInstance; }
                }
            }).catch(err => {
                if (isMounted) {
                    console.error("Camera access failed:", err);
                    alert("Acesso à câmera falhou. Verifique as permissões do navegador.");
                    onCancel();
                }
            });
        return () => {
            isMounted = false;
            mediaStream?.getTracks().forEach(track => track.stop());
        };
    }, [onCancel]);
    const handleTakePhoto = () => {
        const canvas = document.createElement('canvas');
        if (videoRef.current) {
            const video = videoRef.current;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d')?.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
            onCapture(canvas.toDataURL('image/jpeg'));
        }
    };
    return (
        <div className="camera-view" ref={cameraViewRef}>
            <video ref={videoRef} autoPlay playsInline muted />
            <div className="camera-controls">
                <button className="button button-secondary" onClick={onCancel}>Cancelar</button>
                <button id="shutter-button" onClick={handleTakePhoto} aria-label="Tirar Foto"></button>
                <button className="button button-success" onClick={onFinish} disabled={photoCount === 0}>Encerrar</button>
            </div>
        </div>
    );
};

const Login: React.FC<{ onLogin: (user: User) => void; }> = ({ onLogin }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const handleLogin = async () => {
        setError('');
        setIsLoading(true);
        try {
            const { access_token } = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
            setApiToken(access_token);
            const me = await apiFetch('/api/auth/me');
            const user: User = { id: String(me.id), username: me.name || me.email, email: me.email, role: me.role, assignments: me.assignments || [] };
            onLogin(user);
        } catch (err) {
            setError('E-mail ou senha inválidos.');
            setApiToken(null);
        } finally {
            setIsLoading(false);
        }
    };
    return (
        <div className="login-container card">
            <h2>Login de Acesso</h2>
            <p>Entre com suas credenciais.</p>
            {error && <p className="text-danger">{error}</p>}
            <input type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} />
            <input type="password" placeholder="Senha" value={password} onChange={e => setPassword(e.target.value)} />
            <button className="button" onClick={handleLogin} disabled={isLoading}>
                {isLoading ? 'Entrando...' : 'Entrar'}
            </button>
        </div>
    );
};

const AdminDashboard: React.FC<{ onNavigate: (view: View) => void; }> = ({ onNavigate }) => (
    <div className="admin-dashboard">
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_SERVICES')}>Gerenciar Tipos de Serviço</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_LOCATIONS')}>Gerenciar Locais</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_USERS')}>Gerenciar Funcionários</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_GOALS')}>🎯 Metas & Gráficos</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_CYCLES')}>🗓️ Gerenciar Ciclos de Medição</button>
        <button className="button admin-button" onClick={() => onNavigate('REPORTS')}>Gerador de Relatórios</button>
        <button className="button admin-button" onClick={() => onNavigate('HISTORY')}>Histórico Geral</button>
        <button className="button admin-button" onClick={() => onNavigate('AUDIT_LOG')}>📜 Log de Auditoria</button>
    </div>
);

const ManageCyclesView: React.FC<{
    locations: LocationRecord[];
    configs: ContractConfig[];
    fetchData: () => Promise<void>;
}> = ({ locations, configs, fetchData }) => {
    const allContractGroups = [...new Set(locations.map(l => l.contractGroup))].sort();
    const [cycleConfigs, setCycleConfigs] = useState<Record<string, number>>({});

    useEffect(() => {
        const initialState: Record<string, number> = {};
        allContractGroups.forEach(group => {
            const existingConfig = configs.find(c => c.contractGroup === group);
            initialState[group] = existingConfig ? existingConfig.cycleStartDay : 1;
        });
        setCycleConfigs(initialState);
    }, [configs, locations]);

    const [isLoading, setIsLoading] = useState(false);

    const handleDayChange = (contractGroup: string, day: string) => {
        const dayAsNumber = parseInt(day, 10);
        if (day === '' || (dayAsNumber >= 1 && dayAsNumber <= 31)) {
            setCycleConfigs(prev => ({ ...prev, [contractGroup]: day === '' ? 1 : dayAsNumber }));
        }
    };

    const handleSave = async () => {
        setIsLoading(true);
        const payload = {
            configs: Object.entries(cycleConfigs).map(([group, day]) => ({
                contractGroup: group,
                cycleStartDay: day,
            }))
        };
        try {
            await apiFetch('/api/contract-configs', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            await fetchData();
            alert('Ciclos de medição salvos com sucesso!');
        } catch (error) {
            alert('Erro ao salvar as configurações. Tente novamente.');
            console.error(error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="card">
            <h2>Gerenciar Ciclos de Medição</h2>
            <p>Para cada contrato, defina o dia em que o ciclo de medição se inicia (ex: 10 para um ciclo que vai do dia 10 ao dia 9 do mês seguinte).</p>

            <div className="form-container" style={{ gap: '1.5rem', marginTop: '1.5rem', textAlign: 'left' }}>
                {allContractGroups.map(group => (
                    <div key={group} className="form-group">
                        <label htmlFor={`cycle-day-${group}`} style={{ fontWeight: 'bold' }}>{group}</label>
                        <input
                            type="number"
                            id={`cycle-day-${group}`}
                            min="1"
                            max="31"
                            value={cycleConfigs[group] || 1}
                            onChange={(e) => handleDayChange(group, e.target.value)}
                        />
                    </div>
                ))}
            </div>

            <button className="button admin-button" style={{ marginTop: '2rem' }} onClick={handleSave} disabled={isLoading}>
                {isLoading ? 'Salvando...' : 'Salvar Configurações'}
            </button>
        </div>
    );
};

const FiscalDashboard: React.FC<{ onNavigate: (view: View) => void }> = ({ onNavigate }) => (
    <div className="admin-dashboard">
        <button className="button" onClick={() => onNavigate('REPORTS')}>📊 Gerar Relatórios</button>
        <button className="button" onClick={() => onNavigate('HISTORY')}>📖 Histórico de Serviços</button>
    </div>
);

const OperatorGroupSelect: React.FC<{
    user: User;
    onSelectGroup: (group: string) => void
}> = ({ user, onSelectGroup }) => {
    const assignedGroups = [...new Set(user.assignments?.map(a => a.contractGroup) || [])].sort();
    return (
        <div className="card">
            <h2>Selecione o Contrato/Cidade</h2>
            <div className="city-selection-list">
                {assignedGroups.length > 0 ? assignedGroups.map(group => (
                    <button key={group} className="button" onClick={() => onSelectGroup(group)}>{group}</button>
                )) : <p>Nenhum grupo de trabalho atribuído. Contate o administrador.</p>}
            </div>
        </div>
    );
};

const OperatorServiceSelect: React.FC<{
    location: LocationRecord;
    services: ServiceDefinition[];
    user: User;
    onSelectService: (service: ServiceDefinition) => void;
    records: ServiceRecord[];
    contractConfigs: ContractConfig[];
}> = ({ location, services, user, onSelectService, records, contractConfigs }) => {

    // 1. LÓGICA PARA CALCULAR O INÍCIO DO CICLO ATUAL
    const getCurrentCycleStartDate = (contractGroup: string): Date => {
        const config = contractConfigs.find(c => c.contractGroup === contractGroup);
        const cycleStartDay = config ? config.cycleStartDay : 1;

        const today = new Date();
        const currentMonth = today.getMonth();
        const currentYear = today.getFullYear();
        const currentDate = today.getDate();

        let cycleStartDate: Date;

        if (currentDate >= cycleStartDay) {
            // O ciclo atual começou neste mês
            cycleStartDate = new Date(currentYear, currentMonth, cycleStartDay);
        } else {
            // O ciclo atual começou no mês passado
            cycleStartDate = new Date(currentYear, currentMonth - 1, cycleStartDay);
        }

        // Zera as horas para comparar apenas as datas
        cycleStartDate.setHours(0, 0, 0, 0);
        return cycleStartDate;
    };

    // 2. FILTRA OS SERVIÇOS E VERIFICA O STATUS DE CADA UM
    const getServicesWithStatus = () => {
        // Primeiro, pega os IDs dos serviços que ESTÃO configurados para este local
        const locationServiceIds = new Set(location.services?.map(s => s.serviceId) || []);
        if (locationServiceIds.size === 0) {
            // Se o local não tiver serviços específicos, não há o que mostrar.
            return [];
        }

        // Filtra a lista global de serviços para pegar apenas os relevantes
        const availableServices = services.filter(s => locationServiceIds.has(s.id));

        const cycleStartDate = getCurrentCycleStartDate(location.contractGroup);

        // Mapeia cada serviço para um objeto que inclui seu status
        return availableServices.map(service => {
            const isDone = records.some(record =>
                record.locationId === location.id &&
                record.serviceType === service.name &&
                new Date(record.startTime) >= cycleStartDate
            );
            return {
                ...service,
                status: isDone ? 'done' : 'pending'
            };
        });
    };
    const servicesWithStatus = getServicesWithStatus();

    return (
        <div className="card">
            <h2>Escolha o Serviço em "{location.name}"</h2>
            <div className="service-selection-list">
                {servicesWithStatus.length === 0 ? (
                    <p>Nenhum serviço específico foi configurado para este local. Por favor, contate o administrador.</p>
                ) : (
                    servicesWithStatus.map(service => (
                        <button
                            key={service.id}
                            className="button"
                            onClick={() => onSelectService(service)}
                            //disabled={service.status === 'done'} // Desabilita se já foi feito
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                backgroundColor: service.status === 'done' ? '#cccccc' : '' // Cor cinza para desabilitado
                            }}
                        >
                            <span>{service.name} ({service.unit.symbol})</span>

                            {/* Renderiza o ícone de status */}
                            {service.status === 'done' ? (
                                <span style={{ color: 'green', fontSize: '1.5rem' }}>✅</span>
                            ) : (
                                <span style={{ color: '#f0ad4e', fontSize: '1.5rem' }}>⚠️</span>
                            )}
                        </button>
                    ))
                )}
            </div>
        </div>
    );
};

const OperatorLocationSelect: React.FC<{
    locations: LocationRecord[];
    contractGroup: string;
    onSelectLocation: (loc: LocationRecord, service: ServiceDefinition | null, measurement: number | null, gpsUsed: boolean) => void;
    services: ServiceDefinition[];
    currentUser: User | null;
}> = ({ locations, contractGroup, onSelectLocation, services, currentUser }) => {
    const [manualLocationName, setManualLocationName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [gpsLocation, setGpsLocation] = useState<GeolocationCoords | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nearbyLocation, setNearbyLocation] = useState<LocationRecord | null>(null);
    const [selectedService, setSelectedService] = useState<ServiceDefinition | null>(null);
    const [measurement, setMeasurement] = useState<number | ''>('');
    const contractLocations = locations.filter(l => l.contractGroup === contractGroup);

    useEffect(() => {
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const currentCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
                setGpsLocation(currentCoords);
                setError(null);
                const closest = contractLocations.filter(l => l.coords).map(l => ({ ...l, distance: calculateDistance(currentCoords, l.coords!) })).filter(l => l.distance < 100).sort((a, b) => a.distance - b.distance)[0];
                setNearbyLocation(closest || null);
            },
            (err) => {
                console.error("GPS error:", err);
                setError('Não foi possível obter a localização GPS.');
            },
            { enableHighAccuracy: true }
        );
        return () => navigator.geolocation.clearWatch(watchId);
    }, [contractLocations]);

    const handleConfirmNearby = () => {
        if (nearbyLocation) {
            onSelectLocation(nearbyLocation, null, null, true);
        }
    };

    const handleSelectFromList = (loc: LocationRecord) => {
        onSelectLocation(loc, null, null, false);
    };

    const handleCreateAndSelectNew = () => {
        if (!manualLocationName.trim()) {
            alert('Por favor, digite o nome do novo local.');
            return;
        }
        if (!selectedService || measurement === null || measurement === '' || isNaN(Number(measurement))) {
            alert('Por favor, selecione um serviço e digite a medição.');
            return;
        }

        const newManualLocation: LocationRecord = {
            id: `manual-${new Date().getTime()}`,
            name: manualLocationName.trim(),
            contractGroup: contractGroup,
            coords: gpsLocation || undefined,
            services: []
        };

        onSelectLocation(newManualLocation, selectedService, Number(measurement), !!gpsLocation);
    };

    const filteredLocations = contractLocations.filter(loc =>
        loc.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const assignedServices = services.filter(s => {
        const assignment = (currentUser?.assignments || []).find(a => a.contractGroup === contractGroup);
        return assignment?.serviceNames.includes(s.name);
    });

    return (
        <div className="card">
            <h2>Selecione o Local em "{contractGroup}"</h2>
            {error && <p className="text-danger">{error}</p>}
            {!gpsLocation && !error && <Loader text="Obtendo sinal de GPS..." />}
            {nearbyLocation && (
                <div className="card-inset">
                    <h4>Local Próximo Encontrado via GPS</h4>
                    <p><strong>{nearbyLocation.name}</strong></p>
                    <p>Você está neste local?</p>
                    <button className="button" onClick={handleConfirmNearby}>Sim, Confirmar e Continuar</button>
                </div>
            )}
            <div className="card-inset">
                <h4>Ou, busque na lista</h4>
                <input type="search" placeholder="Digite para buscar um local..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ marginBottom: '1rem' }} />
                <div className="location-selection-list">
                    {filteredLocations.length > 0 ? filteredLocations.map(loc => (
                        <button key={loc.id} className="button button-secondary" onClick={() => handleSelectFromList(loc)}>{loc.name}</button>
                    )) : <p>Nenhum local encontrado com esse nome.</p>}
                </div>
            </div>
            <div className="card-inset">
                <h4>Ou, crie um novo local e inicie o serviço</h4>
                <input type="text" placeholder="Digite o nome do NOVO local" value={manualLocationName} onChange={e => setManualLocationName(e.target.value)} />
                <select value={selectedService?.id || ""} onChange={e => setSelectedService(assignedServices.find(s => String(s.id) === e.target.value) || null)} style={{ marginTop: '1rem' }}>
                    <option value="">Selecione o serviço a ser executado</option>
                    {assignedServices.map(s => <option key={s.id} value={s.id}>{s.name} ({s.unit.symbol})</option>)}
                </select>
                {selectedService && (
                    <input
                        type="number"
                        placeholder={`Medição em ${selectedService.unit.symbol}`}
                        value={measurement}
                        onChange={e => setMeasurement(e.target.value)}
                        style={{ marginTop: '1rem' }}
                    />
                )}
                {gpsLocation && <p className="gps-indicator" style={{ textAlign: 'center', marginTop: '1rem' }}>📍 Coordenadas GPS disponíveis para este novo local.</p>}
                <button className="button" onClick={handleCreateAndSelectNew} disabled={!manualLocationName.trim() || !selectedService || measurement === '' || isNaN(Number(measurement))}>Confirmar Novo Local e Iniciar Serviço</button>
            </div>
        </div>
    );
};

const PhotoStep: React.FC<{ phase: 'BEFORE' | 'AFTER'; onComplete: (photos: string[]) => void; onCancel: () => void }> = ({ phase, onComplete, onCancel }) => {
    const [photos, setPhotos] = useState<string[]>([]);
    const [isTakingPhoto, setIsTakingPhoto] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const title = phase === 'BEFORE' ? 'Fotos Iniciais ("Antes")' : 'Fotos Finais ("Depois")';
    const instruction = `Capture fotos do local ${phase === 'BEFORE' ? 'antes' : 'após'} o serviço. Tire quantas quiser. Pressione 'Encerrar' quando terminar.`;

    const handleCapture = (dataUrl: string) => {
        setPhotos(p => [...p, dataUrl]);
    };
    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files) {
            Array.from(files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const dataUrl = e.target?.result as string;
                    if (dataUrl) { setPhotos(p => [...p, dataUrl]); }
                };
                reader.readAsDataURL(file);
            });
        }
        if (event.target) { event.target.value = ''; }
    };
    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };
    if (isTakingPhoto) {
        return <CameraView onCapture={handleCapture} onCancel={() => setIsTakingPhoto(false)} onFinish={() => setIsTakingPhoto(false)} photoCount={photos.length} />
    }
    return (
        <div className="card">
            <h2>{title}</h2>
            <p>{instruction}</p>
            <div className="photo-section">
                <h3>Fotos Capturadas ({photos.length})</h3>
                <div className="photo-gallery">
                    {photos.map((p, i) => <img key={i} src={p} alt={`Foto ${i + 1}`} className="image-preview" />)}
                </div>
                <input type="file" ref={fileInputRef} onChange={handleFileSelect} style={{ display: 'none' }} accept="image/*" multiple />
                <div className="photo-actions">
                    <button className="button" onClick={() => setIsTakingPhoto(true)}>📷 {photos.length > 0 ? 'Tirar Outra Foto' : 'Iniciar Captura'}</button>
                    <button className="button button-secondary" onClick={handleUploadClick}>🖼️ Adicionar Foto do Dispositivo</button>
                </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                <button className="button button-danger" onClick={onCancel}>Cancelar</button>
                <button className="button button-success" onClick={() => onComplete(photos)} disabled={photos.length === 0}>✅ Encerrar Captação</button>
            </div>
        </div>
    );
};

const ConfirmStep: React.FC<{ recordData: Partial<ServiceRecord>; onSave: () => void; onCancel: () => void }> = ({ recordData, onSave, onCancel }) => (
    <div className="card">
        <h2>Confirmação e Salvamento</h2>
        <div className="detail-section" style={{ textAlign: 'left' }}>
            <p><strong>Contrato/Cidade:</strong> {recordData.contractGroup}</p>
            <p><strong>Serviço:</strong> {recordData.serviceType}</p>
            <p><strong>Local:</strong> {recordData.locationName} {recordData.gpsUsed && '📍(GPS)'}</p>
            <p><strong>Data/Hora:</strong> {formatDateTime(new Date().toISOString())}</p>
            {recordData.locationArea ? <p><strong>Metragem:</strong> {recordData.locationArea} {recordData.serviceUnit}</p> : <p><strong>Metragem:</strong> Não informada (novo local)</p>}
            <p>O registro e as fotos foram salvos e enviados ao servidor.</p>
        </div>
        <div className="button-group">
            <button className="button button-secondary" onClick={onCancel}>Voltar ao Início</button>
            <button className="button button-success" onClick={onSave}>✅ Concluir</button>
        </div>
    </div>
);

interface HistoryViewProps {
    records: ServiceRecord[];
    onSelect: (record: ServiceRecord) => void;
    isAdmin: boolean;
    onEdit?: (record: ServiceRecord) => void;
    onDelete?: (recordId: string) => void;
    selectedIds: Set<string>;
    onToggleSelect: (recordId: string) => void;
    onDeleteSelected?: () => void;
}
const HistoryView: React.FC<HistoryViewProps> = ({ records, onSelect, isAdmin, onEdit, onDelete, selectedIds, onToggleSelect, onDeleteSelected }) => (
    <div>
        {isAdmin && selectedIds.size > 0 && (
            <div style={{ marginBottom: '1rem', textAlign: 'center' }}>
                <button className="button button-danger" onClick={onDeleteSelected}>
                    Excluir {selectedIds.size} Iten(s) Selecionado(s)
                </button>
            </div>
        )}
        {records.length === 0 ? <p style={{ textAlign: 'center' }}>Nenhum serviço registrado ainda.</p>
            : (
                <ul className="history-list">
                    {records.map(record => (
                        <li key={record.id} className="list-item" style={{ alignItems: 'center' }}>
                            {isAdmin && (
                                <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, marginRight: '1rem' }}>
                                    <input type="checkbox" checked={selectedIds.has(record.id)} onChange={() => onToggleSelect(record.id)} style={{ width: '24px', height: '24px' }} />
                                </div>
                            )}
                            <div onClick={() => onSelect(record)} style={{ flexGrow: 1, cursor: 'pointer' }}>
                                <p><strong>Local:</strong> {record.locationName}, {record.contractGroup} {record.gpsUsed && <span className="gps-indicator">📍</span>}</p>
                                <p><strong>Serviço:</strong> {record.serviceType}</p>
                                <p><strong>Data:</strong> {formatDateTime(record.startTime)}</p>
                                {isAdmin && <p><strong>Operador:</strong> {record.operatorName}</p>}
                                <div className="history-item-photos">
                                    {(record.beforePhotos || []).slice(0, 2).map((p, i) => <img key={`b-${i}`} src={`${API_BASE}${p}`} alt="antes" />)}
                                    {(record.afterPhotos || []).slice(0, 2).map((p, i) => <img key={`a-${i}`} src={`${API_BASE}${p}`} alt="depois" />)}
                                </div>
                            </div>
                            <div className="list-item-actions">
                                {isAdmin && onEdit && (<button className="button button-sm admin-button" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>Editar</button>)}
                                {!isAdmin && onEdit && (<button className="button button-sm" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>Reabrir</button>)}
                                {isAdmin && onDelete && (<button className="button button-sm button-danger" onClick={(e) => { e.stopPropagation(); onDelete(record.id); }}>Excluir</button>)}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
    </div>
);

const DetailView: React.FC<{ record: ServiceRecord }> = ({ record }) => (
    <div className="detail-view">
        <div className="detail-section card">
            <h3>Resumo</h3>
            <p><strong>Contrato/Cidade:</strong> {record.contractGroup}</p>
            <p><strong>Local:</strong> {record.locationName} {record.gpsUsed && <span className='gps-indicator'>📍(GPS)</span>}</p>
            <p><strong>Serviço:</strong> {record.serviceType}</p>
            {record.locationArea ? <p><strong>Metragem:</strong> {record.locationArea} {record.serviceUnit}</p> : <p><strong>Metragem:</strong> Não informada</p>}
            <p><strong>Operador:</strong> {record.operatorName}</p>
            <p><strong>Início:</strong> {formatDateTime(record.startTime)}</p>
            <p><strong>Fim:</strong> {record.endTime ? formatDateTime(record.endTime) : 'Não finalizado'}</p>
        </div>
        <div className="detail-section card">
            <h3>Fotos "Antes" ({(record.beforePhotos || []).length})</h3>
            <div className="photo-gallery">{(record.beforePhotos || []).map((p, i) => <img key={`b-${i}`} src={`${API_BASE}${p}`} alt={`Antes ${i + 1}`} />)}</div>
        </div>
        <div className="detail-section card">
            <h3>Fotos "Depois" ({(record.afterPhotos || []).length})</h3>
            <div className="photo-gallery">{(record.afterPhotos || []).map((p, i) => <img key={`a-${i}`} src={`${API_BASE}${p}`} alt={`Depois ${i + 1}`} />)}</div>
        </div>
    </div>
);

const ReportsView: React.FC<{ records: ServiceRecord[]; services: ServiceDefinition[]; }> = ({ records, services }) => {
    const [reportType, setReportType] = useState<'excel' | 'photos' | null>(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [selectedServices, setSelectedServices] = useState<string[]>([]);
    const [selectedContractGroup, setSelectedContractGroup] = useState('');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const printableRef = useRef<HTMLDivElement>(null);
    const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

    const allServiceNames = services.map(s => s.name);
    const allContractGroups = [...new Set(records.map(r => r.contractGroup))].sort();

    const handleServiceFilterChange = (service: string, isChecked: boolean) => { setSelectedServices(prev => isChecked ? [...prev, service] : prev.filter(s => s !== service)); };

    const filteredRecords = records.filter(r => {
        const recordDate = new Date(r.startTime);
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;
        if (start && recordDate < start) return false;
        if (end) { end.setHours(23, 59, 59, 999); if (recordDate > end) return false; }
        if (selectedServices.length > 0 && !selectedServices.includes(r.serviceType)) return false;
        if (selectedContractGroup && r.contractGroup !== selectedContractGroup) return false;
        return true;
    }).sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

    const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.checked) setSelectedIds(filteredRecords.map(r => r.id));
        else setSelectedIds([]);
    };

    const handleSelectOne = (id: string, isChecked: boolean) => {
        if (isChecked) setSelectedIds(ids => [...ids, id]);
        else setSelectedIds(ids => ids.filter(i => i !== id));
    };

    const selectedRecords = records.filter(r => selectedIds.includes(r.id));
    const totalArea = selectedRecords.reduce((sum, r) => sum + (r.locationArea || 0), 0);

    const handleExportExcel = async () => {
        if (selectedRecords.length === 0) {
            alert("Nenhum registro selecionado para exportar.");
            return;
        }
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relatório de Serviços');
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 }, { header: 'Data Início', key: 'startTime', width: 20 },
            { header: 'Data Fim', key: 'endTime', width: 20 }, { header: 'Contrato/Cidade', key: 'contractGroup', width: 25 },
            { header: 'Local', key: 'locationName', width: 40 }, { header: 'Serviço', key: 'serviceType', width: 30 },
            { header: 'Medição', key: 'locationArea', width: 15 }, { header: 'Unidade', key: 'serviceUnit', width: 15 },
            { header: 'Operador', key: 'operatorName', width: 25 }, { header: 'Usou GPS', key: 'gpsUsed', width: 10 },
        ];
        selectedRecords.forEach(record => {
            worksheet.addRow({
                id: record.id, startTime: formatDateTime(record.startTime),
                endTime: record.endTime ? formatDateTime(record.endTime) : 'Não finalizado',
                contractGroup: record.contractGroup, locationName: record.locationName,
                serviceType: record.serviceType, locationArea: record.locationArea,
                serviceUnit: record.serviceUnit, operatorName: record.operatorName,
                gpsUsed: record.gpsUsed ? 'Sim' : 'Não',
            });
        });
        try {
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `relatorio_crb_${new Date().toISOString().split('T')[0]}.xlsx`;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (error) {
            console.error("Erro ao gerar Excel:", error);
            alert("Ocorreu um erro ao gerar o arquivo Excel.");
        }
    };

    const handleGeneratePdfClick = () => {
        if (selectedRecords.length === 0) {
            alert("Por favor, selecione ao menos um registro para gerar o PDF.");
            return;
        }
        setIsGeneratingPdf(true);
    };

    const PdfLayout = () => {
        const recordsPerPage = 2;
        const [pages, setPages] = useState<ServiceRecord[][]>([]);
        const [loadedImages, setLoadedImages] = useState<Record<string, string>>({});
        const [isLoadingImages, setIsLoadingImages] = useState(true);

        const getBase64Image = (url: string): Promise<string> => {
            return new Promise(async (resolve) => {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error('Network response was not ok');
                    const blob = await response.blob();
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = () => resolve("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
                    reader.readAsDataURL(blob);
                } catch (error) {
                    console.error(`Failed to fetch image ${url}:`, error);
                    resolve("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
                }
            });
        };

        useEffect(() => {
            const processRecords = async () => {
                const allImageUrls = selectedRecords.flatMap(r => [...(r.beforePhotos || []), ...(r.afterPhotos || [])]);
                const uniqueImageUrls = [...new Set(allImageUrls)];
                const imagePromises = uniqueImageUrls.map(url => getBase64Image(`${API_BASE}${url}`).then(base64 => ({ url, base64 })));
                const results = await Promise.all(imagePromises);
                const imageMap = results.reduce((acc, { url, base64 }) => {
                    acc[`${API_BASE}${url}`] = base64;
                    return acc;
                }, {} as Record<string, string>);
                setLoadedImages(imageMap);
                const paginatedRecords = [];
                for (let i = 0; i < selectedRecords.length; i += recordsPerPage) {
                    paginatedRecords.push(selectedRecords.slice(i, i + recordsPerPage));
                }
                setPages(paginatedRecords);
                setIsLoadingImages(false);
            };
            if (selectedRecords.length > 0) { processRecords(); } else { setIsLoadingImages(false); }
        }, []);

        useEffect(() => {
            if (!isLoadingImages && pages.length > 0) {
                (async () => {
                    if (!printableRef.current) return;
                    try {
                        const doc = new jsPDF('p', 'mm', 'a4');
                        const pageElements = printableRef.current.querySelectorAll('.printable-page');
                        for (let i = 0; i < pageElements.length; i++) {
                            const page = pageElements[i] as HTMLElement;
                            const canvas = await html2canvas(page, { scale: 2, useCORS: true, logging: false });
                            if (i > 0) doc.addPage();
                            doc.addImage(canvas.toDataURL('image/jpeg', 0.8), 'JPEG', 0, 0, doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight());
                        }
                        doc.save(`relatorio_fotos_crb_${new Date().toISOString().split('T')[0]}.pdf`);
                    } catch (error) {
                        console.error("Erro ao gerar PDF:", error);
                        alert("Ocorreu um erro ao gerar o PDF.");
                    } finally {
                        setIsGeneratingPdf(false);
                    }
                })();
            }
        }, [isLoadingImages, pages]);

        if (isLoadingImages) return null;

        const today = new Date().toLocaleDateString('pt-BR');
        return (
            <div className="printable-report-container" ref={printableRef}>
                {pages.map((pageRecords, pageIndex) => (
                    <div key={pageIndex} className="printable-page">
                        <header className="pdf-page-header">
                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                <img src={logoSrc} alt="Logo" style={{ maxHeight: '25px', width: 'auto' }} />
                                <h2 style={{ fontSize: '16pt', margin: '0 0 0 10px' }}>Relatório Fotográfico</h2>
                            </div>
                            <p style={{ textAlign: 'right', fontSize: '10pt' }}>CRB Serviços<br />Data de Emissão: {today}</p>
                        </header>
                        <div className="pdf-page-content">
                            {pageRecords.map(record => {
                                const photoPairs = [];
                                const maxPhotos = Math.max((record.beforePhotos || []).length, (record.afterPhotos || []).length);
                                for (let i = 0; i < maxPhotos; i++) {
                                    photoPairs.push({ before: record.beforePhotos?.[i], after: record.afterPhotos?.[i] });
                                }
                                return (
                                    <div key={record.id} className="pdf-record-block">
                                        <div className="pdf-record-info">
                                            <h3>{record.locationName}</h3>
                                            <p>
                                                <strong>Contrato/Cidade:</strong> {record.contractGroup} |
                                                <strong> Serviço:</strong> {record.serviceType} |
                                                <strong> Data:</strong> {formatDateTime(record.startTime)}
                                                {record.locationArea && record.locationArea > 0 && (
                                                    <>
                                                        {' | '}
                                                        <strong>Medição:</strong>
                                                        {` ${record.locationArea.toLocaleString('pt-BR')} ${record.serviceUnit}`}
                                                    </>
                                                )}
                                            </p>
                                        </div>
                                        <table className="pdf-photo-table">
                                            <thead><tr><th>ANTES</th><th>DEPOIS</th></tr></thead>
                                            <tbody>
                                                {photoPairs.map((pair, index) => (
                                                    <tr key={index}>
                                                        <td>
                                                            {pair.before && <img src={loadedImages[`${API_BASE}${pair.before}`]} alt={`Antes ${index + 1}`} />}
                                                            <p className="caption">Foto Antes {index + 1}</p>
                                                        </td>
                                                        <td>
                                                            {pair.after && <img src={loadedImages[`${API_BASE}${pair.after}`]} alt={`Depois ${index + 1}`} />}
                                                            <p className="caption">Foto Depois {index + 1}</p>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                );
                            })}
                        </div>
                        <footer className="pdf-page-footer">Página {pageIndex + 1} de {pages.length}</footer>
                    </div>
                ))}
            </div>
        );
    };

    if (isGeneratingPdf) {
        return (
            <>
                <Loader text="Gerando PDF, por favor aguarde..." />
                <PdfLayout />
            </>
        );
    }

    if (!reportType) {
        return (
            <div className="card">
                <h2>Selecione o Tipo de Relatório</h2>
                <div className="button-group" style={{ flexDirection: 'column', gap: '1rem' }}>
                    <button className="button" onClick={() => setReportType('excel')}>📊 Relatório Planilha de Excel</button>
                    <button className="button button-secondary" onClick={() => setReportType('photos')}>🖼️ Relatório de Fotografias (PDF)</button>
                </div>
            </div>
        );
    }

    return (
        <div className="card">
            <button className="button button-sm button-secondary" onClick={() => setReportType(null)} style={{ float: 'right' }}>Trocar Tipo</button>
            <h2>Filtros para Relatório de {reportType === 'excel' ? 'Excel' : 'Fotos'}</h2>
            <div className="report-filters" style={{ flexDirection: 'column', alignItems: 'stretch', clear: 'both' }}>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    <div className="form-group"><label>Data de Início</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
                    <div className="form-group"><label>Data Final</label><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
                    <div className="form-group"><label>Contrato/Cidade</label><select value={selectedContractGroup} onChange={e => setSelectedContractGroup(e.target.value)}><option value="">Todos</option>{allContractGroups.map(g => <option key={g} value={g}>{g}</option>)}</select></div>
                </div>
                <fieldset className="form-group-full"><legend>Filtrar por Serviços</legend><div className="checkbox-group">{allServiceNames.map(name => (<div key={name} className="checkbox-item"><input type="checkbox" id={`service-${name}`} checked={selectedServices.includes(name)} onChange={e => handleServiceFilterChange(name, e.target.checked)} /><label htmlFor={`service-${name}`}>{name}</label></div>))}</div></fieldset>
            </div>

            <div className="report-summary">
                <h3>{selectedIds.length} de {filteredRecords.length} registros selecionados</h3>
                {reportType === 'excel' && <p>Total Medição (Excel): {totalArea.toLocaleString('pt-br')} </p>}
                <div className="button-group">
                    {reportType === 'excel' && <button className="button" onClick={handleExportExcel} disabled={selectedIds.length === 0}>Exportar para Excel</button>}
                    {reportType === 'photos' && <button className="button" onClick={handleGeneratePdfClick} disabled={selectedIds.length === 0}>Gerar PDF com Fotos</button>}
                </div>
            </div>
            <ul className="report-list" style={{ marginTop: '1rem' }}>
                {filteredRecords.length > 0 && <li><label><input type="checkbox" onChange={handleSelectAll} checked={selectedIds.length === filteredRecords.length && filteredRecords.length > 0} /> Selecionar Todos</label></li>}
                {filteredRecords.map(record => (
                    <li key={record.id} className="report-item">
                        <input type="checkbox" checked={selectedIds.includes(record.id)} onChange={e => handleSelectOne(record.id, e.target.checked)} />
                        <div className="report-item-info">
                            <p><strong>{record.locationName}</strong> - {record.serviceType}</p>
                            <p><small>{record.contractGroup} | {formatDateTime(record.startTime)}</small></p>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
};

const ManageLocationsView: React.FC<{
    locations: LocationRecord[];
    services: ServiceDefinition[];
    fetchData: () => Promise<void>;
}> = ({ locations, services, fetchData }) => {
    const [selectedGroup, setSelectedGroup] = useState('');
    const [name, setName] = useState('');
    const [coords, setCoords] = useState<Partial<GeolocationCoords> | null>(null);
    const [isFetchingCoords, setIsFetchingCoords] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [serviceMeasurements, setServiceMeasurements] = useState<Record<string, string>>({});

    const allGroups = [...new Set(locations.map(l => l.contractGroup))].filter(Boolean).sort();

    const resetForm = () => {
        setName('');
        setCoords(null);
        setServiceMeasurements({});
        setEditingId(null);
    };

    const handleAddNewGroup = () => {
        const newGroup = prompt('Digite o nome do novo Contrato/Cidade:');
        if (newGroup) {
            setSelectedGroup(newGroup.trim());
            resetForm();
        }
    };

    const handleGetCoordinates = () => {
        setIsFetchingCoords(true);
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
                setIsFetchingCoords(false);
            },
            (error) => {
                alert(`Erro ao obter GPS: ${error.message}`);
                setIsFetchingCoords(false);
            },
            { enableHighAccuracy: true }
        );
    };

    const handleCoordChange = (field: 'latitude' | 'longitude', valueStr: string) => {
        const value = parseFloat(valueStr);
        setCoords(curr => {
            const newCoords = { ...(curr || {}) };
            (newCoords as any)[field] = isNaN(value) ? undefined : value;
            if (newCoords.latitude === undefined && newCoords.longitude === undefined) return null;
            return newCoords;
        });
    };

    const handleMeasurementChange = (serviceId: string, value: string) => {
        setServiceMeasurements(prev => ({ ...prev, [serviceId]: value }));
    };

    const handleServiceToggle = (serviceId: string, isChecked: boolean) => {
        const newMeasurements = { ...serviceMeasurements };
        if (isChecked) {
            newMeasurements[serviceId] = '';
        } else {
            delete newMeasurements[serviceId];
        }
        setServiceMeasurements(newMeasurements);
    };

    const handleSave = async () => {
        if (!selectedGroup || !name) {
            alert('Contrato/Cidade e Nome do Local são obrigatórios.');
            return;
        }

        const servicesPayload = Object.entries(serviceMeasurements)
            .filter(([_, measurement]) => measurement && !isNaN(parseFloat(measurement)))
            .map(([service_id, measurement]) => ({
                service_id,
                measurement: parseFloat(measurement)
            }));

        if (servicesPayload.length === 0) {
            if (!window.confirm("Nenhum serviço com medição foi adicionado. Deseja salvar este local mesmo assim?")) {
                return;
            }
        }

        const payload = {
            city: selectedGroup.trim(),
            name,
            lat: coords?.latitude,
            lng: coords?.longitude,
            services: servicesPayload,
        };

        try {
            if (editingId) {
                await apiFetch(`/api/locations/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/locations', { method: 'POST', body: JSON.stringify(payload) });
            }
            alert(`Local "${name}" salvo com sucesso!`);
            resetForm();
            await fetchData();
        } catch (error) {
            alert('Falha ao salvar local.');
            console.error(error);
        }
    };

    const handleEdit = (loc: LocationRecord) => {
        setEditingId(loc.id);
        setName(loc.name);
        setCoords(loc.coords || null);
        setSelectedGroup(loc.contractGroup);
        const initialMeasurements = (loc.services || []).reduce((acc, srv) => {
            acc[srv.serviceId] = String(srv.measurement);
            return acc;
        }, {} as Record<string, string>);
        setServiceMeasurements(initialMeasurements);
    };

    const handleDelete = async (id: string) => {
        if (window.confirm('Excluir este local?')) {
            try {
                await apiFetch(`/api/locations/${id}`, { method: 'DELETE' });
                await fetchData();
            } catch (error) {
                alert('Falha ao excluir local. Tente novamente.');
                console.error(error);
            }
        }
    };

    const filteredLocations = selectedGroup ? locations.filter(l => l.contractGroup === selectedGroup) : [];

    return (
        <div>
            <div className="card">
                <h3>Gerenciar Locais por Contrato/Cidade</h3>
                <div className="form-group contract-group-selector">
                    <select value={selectedGroup} onChange={e => { setSelectedGroup(e.target.value); resetForm(); }}>
                        <option value="">Selecione um Contrato/Cidade</option>
                        {allGroups.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <button className="button button-secondary" onClick={handleAddNewGroup}>Adicionar Novo</button>
                </div>
            </div>

            {selectedGroup && (
                <>
                    <div className="form-container card">
                        <h3>{editingId ? 'Editando Local' : 'Adicionar Novo Local'} em "{selectedGroup}"</h3>
                        <input type="text" placeholder="Nome do Local (Endereço)" value={name} onChange={e => setName(e.target.value)} />

                        <fieldset className="service-assignment-fieldset">
                            <legend>Serviços e Medições do Local</legend>
                            <div className="checkbox-group">
                                {services.sort((a, b) => a.name.localeCompare(b.name)).map(service => {
                                    const isChecked = service.id in serviceMeasurements;
                                    return (
                                        <div key={service.id} className="checkbox-item" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem', border: '1px solid #eee', padding: '0.5rem', borderRadius: '4px' }}>
                                            <div>
                                                <input type="checkbox" id={`service-loc-${service.id}`} checked={isChecked} onChange={e => handleServiceToggle(service.id, e.target.checked)} />
                                                <label htmlFor={`service-loc-${service.id}`}>{service.name}</label>
                                            </div>
                                            {isChecked && (
                                                <input type="number" placeholder={`Medição (${service.unit.symbol})`} value={serviceMeasurements[service.id] || ''} onChange={e => handleMeasurementChange(service.id, e.target.value)} style={{ width: '100%' }} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </fieldset>

                        <fieldset className="form-group-full">
                            <legend>Coordenadas GPS (Opcional)</legend>
                            <div className="coord-inputs">
                                <input type="number" placeholder="Latitude" value={coords?.latitude || ''} onChange={e => handleCoordChange('latitude', e.target.value)} />
                                <input type="number" placeholder="Longitude" value={coords?.longitude || ''} onChange={e => handleCoordChange('longitude', e.target.value)} />
                            </div>
                            <button className="button button-secondary" onClick={handleGetCoordinates} disabled={isFetchingCoords} style={{ marginTop: '0.5rem' }}>
                                {isFetchingCoords ? 'Obtendo...' : '📍 Obter GPS Atual'}
                            </button>
                        </fieldset>

                        <button className="button admin-button" onClick={handleSave}>{editingId ? 'Salvar Alterações' : 'Adicionar Local'}</button>
                        {editingId && <button className="button button-secondary" onClick={resetForm}>Cancelar Edição</button>}
                    </div>

                    <ul className="location-list">
                        {filteredLocations.sort((a, b) => a.name.localeCompare(b.name)).map(loc => (
                            <li key={loc.id} className="card list-item">
                                <div className="list-item-info">
                                    <div className="list-item-header">
                                        <h3>{loc.name}</h3>
                                        <div>
                                            <button className="button button-sm admin-button" onClick={() => handleEdit(loc)}>Editar</button>
                                            <button className="button button-sm button-danger" onClick={() => handleDelete(loc.id)}>Excluir</button>
                                        </div>
                                    </div>
                                    <div className="location-services-list">
                                        <strong>Serviços:</strong>
                                        {(loc.services && loc.services.length > 0) ? (
                                            <ul>{loc.services.map(s => <li key={s.serviceId}>{s.name}: {s.measurement} {s.unit.symbol}</li>)}</ul>
                                        ) : ' Nenhum atribuído'}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
};

const ManageUsersView: React.FC<{
    users: User[];
    onUsersUpdate: () => Promise<void>;
    services: ServiceDefinition[];
    locations: LocationRecord[];
}> = ({ users, onUsersUpdate, services, locations }) => {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState<Role>('OPERATOR');
    const [assignments, setAssignments] = useState<UserAssignment[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    // State for the 'add new assignment' form
    const [newAssignmentGroup, setNewAssignmentGroup] = useState('');
    const [newAssignmentServices, setNewAssignmentServices] = useState<Set<string>>(new Set());

    const allGroups = [...new Set(locations.map(l => l.contractGroup))].sort();
    const allServices = [...services].sort((a, b) => a.name.localeCompare(b.name));

    const resetForm = () => {
        setUsername('');
        setPassword('');
        setEmail('');
        setRole('OPERATOR');
        setAssignments([]);
        setEditingId(null);
    };

    const handleAddAssignment = () => {
        if (!newAssignmentGroup) {
            alert('Por favor, selecione um Contrato/Cidade.');
            return;
        }
        if (newAssignmentServices.size === 0) {
            alert('Por favor, selecione pelo menos um serviço.');
            return;
        }
        if (assignments.some(a => a.contractGroup === newAssignmentGroup)) {
            alert('Este contrato já foi atribuído. Remova o antigo para adicionar um novo com serviços diferentes.');
            return;
        }

        setAssignments(prev => [
            ...prev,
            { contractGroup: newAssignmentGroup, serviceNames: Array.from(newAssignmentServices) }
        ].sort((a, b) => a.contractGroup.localeCompare(b.contractGroup)));

        setNewAssignmentGroup('');
        setNewAssignmentServices(new Set());
    };

    const handleRemoveAssignment = (groupToRemove: string) => {
        setAssignments(prev => prev.filter(a => a.contractGroup !== groupToRemove));
    };

    const handleServiceCheckbox = (serviceName: string, checked: boolean) => {
        setNewAssignmentServices(prev => {
            const newSet = new Set(prev);
            if (checked) {
                newSet.add(serviceName);
            } else {
                newSet.delete(serviceName);
            }
            return newSet;
        });
    };

    const handleSave = async () => {
        if (!username || !email) {
            alert('Nome e e-mail são obrigatórios.');
            return;
        }
        if (!editingId && !password) {
            alert('A senha é obrigatória para novos usuários.');
            return;
        }

        setIsLoading(true);

        const payload: any = {
            name: username,
            email,
            role,
        };
        if (password) {
            payload.password = password;
        }
        if (role === 'OPERATOR' || role === 'FISCAL') {
            payload.assignments = assignments;
        }

        try {
            if (editingId) {
                await apiFetch(`/api/users/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(payload) });
            }
            await onUsersUpdate(); // Refetch users from the server
            resetForm();
        } catch (e) {
            alert('Falha ao salvar usuário. Verifique se o e-mail já existe.');
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleEdit = (user: User) => {
        setEditingId(user.id);
        setUsername(user.username);
        setEmail(user.email || '');
        setPassword(''); // Don't show existing password
        setRole(user.role);
        setAssignments(user.assignments || []);
    };

    const handleDelete = async (id: string) => {
        if (window.confirm('Excluir este usuário? Esta ação não pode ser desfeita.')) {
            setIsLoading(true);
            try {
                await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
                await onUsersUpdate();
            } catch (e) {
                alert('Falha ao excluir usuário.');
                console.error(e);
            } finally {
                setIsLoading(false);
            }
        }
    };

    return (
        <div>
            <div className="form-container card">
                <h3>{editingId ? 'Editando Funcionário' : 'Adicionar Novo Funcionário'}</h3>
                <input type="text" placeholder="Nome de usuário" value={username} onChange={e => setUsername(e.target.value)} />
                <input type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} />
                <input type="text" placeholder={editingId ? 'Nova Senha (deixe em branco para não alterar)' : 'Senha'} value={password} onChange={e => setPassword(e.target.value)} />
                <select value={role} onChange={e => setRole(e.target.value as Role)}>
                    <option value="OPERATOR">Operador</option>
                    <option value="FISCAL">Fiscalização</option>
                    <option value="ADMIN">Administrador</option>
                </select>

                {(role === 'OPERATOR' || role === 'FISCAL') && (
                    <fieldset className="assignment-section">
                        <legend>Atribuições (Contratos/Serviços)</legend>

                        {assignments.length > 0 && (
                            <ul className="assignment-list">
                                {assignments.map(assign => (
                                    <li key={assign.contractGroup} className="assignment-item">
                                        <div className="assignment-item-info">
                                            <strong>{assign.contractGroup}</strong>
                                            <p>{assign.serviceNames.join(', ')}</p>
                                        </div>
                                        <button className="button button-sm button-danger" onClick={() => handleRemoveAssignment(assign.contractGroup)}>Remover</button>
                                    </li>
                                ))}
                            </ul>
                        )}

                        <div className="add-assignment-form">
                            <h4>Adicionar Nova Atribuição</h4>
                            <select value={newAssignmentGroup} onChange={e => setNewAssignmentGroup(e.target.value)}>
                                <option value="">Selecione o Contrato/Cidade</option>
                                {allGroups.map(g => <option key={g} value={g}>{g}</option>)}
                            </select>
                            <div className="checkbox-group">
                                {allServices.map(service => (
                                    <div key={service.id} className="checkbox-item">
                                        <input type="checkbox" id={`service-assign-${service.id}`}
                                            checked={newAssignmentServices.has(service.name)}
                                            onChange={e => handleServiceCheckbox(service.name, e.target.checked)} />
                                        <label htmlFor={`service-assign-${service.id}`}>{service.name}</label>
                                    </div>
                                ))}
                            </div>
                            <button type="button" className="button button-sm" onClick={handleAddAssignment}>Adicionar Atribuição</button>
                        </div>
                    </fieldset>
                )}

                <button className="button admin-button" onClick={handleSave} disabled={isLoading}>{isLoading ? 'Salvando...' : (editingId ? 'Salvar Alterações' : 'Adicionar')}</button>
                {editingId && <button className="button button-secondary" onClick={resetForm}>Cancelar</button>}
            </div>
            <ul className="location-list">
                {users.map(user => (
                    <li key={user.id} className="card list-item">
                        <div className="list-item-header">
                            <h3>{user.username}</h3>
                            <div>
                                <button className="button button-sm admin-button" onClick={() => handleEdit(user)}>Editar</button>
                                <button className="button button-sm button-danger" onClick={() => handleDelete(user.id)}>Excluir</button>
                            </div>
                        </div>
                        <p><strong>Função:</strong> {user.role}</p>
                        <p><strong>Email:</strong> {user.email}</p>
                    </li>
                ))}
            </ul>
        </div>
    );
};

const GoalsAndChartsView: React.FC<{
    records: ServiceRecord[];
    locations: LocationRecord[];
}> = ({ records, locations }) => {
    // Lógica do Gráfico
    const [chartData, setChartData] = useState<any>(null);
    const [isLoadingChart, setIsLoadingChart] = useState(false);
    const [chartType, setChartType] = useState<'bar' | 'line'>('bar');
    const allContractGroups = [...new Set(locations.map(l => l.contractGroup).concat(records.map(r => r.contractGroup)))].filter(Boolean).sort();

    const [selectedContracts, setSelectedContracts] = useState<string[]>(allContractGroups);
    const defaultEndDate = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setMonth(defaultStartDate.getMonth() - 11); // Padrão: últimos 12 meses
    const [startDate, setStartDate] = useState(defaultStartDate.toISOString().slice(0, 10));
    const [endDate, setEndDate] = useState(defaultEndDate.toISOString().slice(0, 10));

    const handleContractSelection = (contract: string, isChecked: boolean) => {
        setSelectedContracts(prev => isChecked ? [...prev, contract] : prev.filter(c => c !== contract));
    };

    const handleGenerateChart = async () => {
        if (selectedContracts.length === 0) {
            alert('Por favor, selecione pelo menos um contrato.');
            return;
        }
        setIsLoadingChart(true);
        setChartData(null);
        try {
            const params = new URLSearchParams({ startDate, endDate });
            selectedContracts.forEach(c => params.append('contractGroups', c));
            const data = await apiFetch(`/api/reports/performance-graph?${params.toString()}`);
            setChartData(data);
        } catch (error) {
            alert('Erro ao gerar dados para o gráfico.');
            console.error(error);
        } finally {
            setIsLoadingChart(false);
        }
    };

    const chartOptions = {
        responsive: true,
        plugins: { legend: { position: 'top' as const }, title: { display: true, text: 'Volume de Medição Mensal' } },
        scales: { y: { beginAtZero: true } }
    };

    const [goals, setGoals] = useLocalStorage<Goal[]>('crbGoals', []);
    const [contractGroupGoal, setContractGroupGoal] = useState('');
    const [monthGoal, setMonthGoal] = useState(new Date().toISOString().substring(0, 7));
    const [targetAreaGoal, setTargetAreaGoal] = useState('');
    const [editingIdGoal, setEditingIdGoal] = useState<string | null>(null);

    const resetFormGoal = () => {
        setContractGroupGoal('');
        setMonthGoal(new Date().toISOString().substring(0, 7));
        setTargetAreaGoal('');
        setEditingIdGoal(null);
    };

    const handleSaveGoal = () => {
        if (!contractGroupGoal || !monthGoal || !targetAreaGoal || isNaN(parseFloat(targetAreaGoal))) {
            alert('Preencha todos os campos da meta corretamente.');
            return;
        }
        const newGoal: Goal = {
            id: editingIdGoal || new Date().toISOString(),
            contractGroup: contractGroupGoal,
            month: monthGoal,
            targetArea: parseFloat(targetAreaGoal),
        };
        if (editingIdGoal) {
            setGoals(prevGoals => prevGoals.map(g => g.id === editingIdGoal ? newGoal : g));
        } else {
            setGoals(prevGoals => [newGoal, ...prevGoals]);
        }
        resetFormGoal();
    };

    const handleEditGoal = (goal: Goal) => {
        setEditingIdGoal(goal.id);
        setContractGroupGoal(goal.contractGroup);
        setMonthGoal(goal.month);
        setTargetAreaGoal(String(goal.targetArea));
    };

    const handleDeleteGoal = (id: string) => {
        if (window.confirm('Excluir esta meta?')) {
            setGoals(prevGoals => prevGoals.filter(g => g.id !== id));
        }
    };

    return (
        <div>
            <div className="card">
                <h3>Análise Gráfica de Desempenho</h3>
                <div className="report-filters" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                        <div className="form-group">
                            <label htmlFor="start-date-chart">Data de Início</label>
                            <input id="start-date-chart" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="end-date-chart">Data Final</label>
                            <input id="end-date-chart" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
                        </div>
                    </div>
                    <fieldset className="form-group-full">
                        <legend>Comparar Contratos</legend>
                        <div className="button-group" style={{ justifyContent: 'flex-start', marginBottom: '1rem' }}>
                            <button className="button button-sm" onClick={() => setSelectedContracts(allContractGroups)}>Selecionar Todos</button>
                            <button className="button button-sm button-secondary" onClick={() => setSelectedContracts([])}>Limpar Seleção</button>
                        </div>
                        <div className="checkbox-group">
                            {allContractGroups.map(group => (
                                <div key={group} className="checkbox-item">
                                    <input type="checkbox" id={`contract-${group}`} checked={selectedContracts.includes(group)} onChange={e => handleContractSelection(group, e.target.checked)} />
                                    <label htmlFor={`contract-${group}`}>{group}</label>
                                </div>
                            ))}
                        </div>
                    </fieldset>
                    <fieldset className="form-group-full">
                        <legend>Tipo de Gráfico</legend>
                        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                            <div className="checkbox-item"><input type="radio" id="chart-bar" name="chartType" value="bar" checked={chartType === 'bar'} onChange={() => setChartType('bar')} /><label htmlFor="chart-bar">Barras</label></div>
                            <div className="checkbox-item"><input type="radio" id="chart-line" name="chartType" value="line" checked={chartType === 'line'} onChange={() => setChartType('line')} /><label htmlFor="chart-line">Linhas</label></div>
                        </div>
                    </fieldset>
                    <button className="button admin-button" onClick={handleGenerateChart} disabled={isLoadingChart}>
                        {isLoadingChart ? 'Gerando...' : 'Gerar Gráfico'}
                    </button>
                </div>
                {isLoadingChart && <Loader text="Carregando dados do gráfico..." />}
                {chartData && (
                    <div style={{ marginTop: '2rem' }}>
                        {chartType === 'bar' ? <Bar options={chartOptions} data={chartData} /> : <Line options={chartOptions} data={chartData} />}
                    </div>
                )}
            </div>

            <div className="form-container card">
                <h3>{editingIdGoal ? 'Editando Meta' : 'Adicionar Nova Meta'} (Local)</h3>
                <input list="goal-contract-groups" placeholder="Digite ou selecione um Contrato/Cidade" value={contractGroupGoal} onChange={e => setContractGroupGoal(e.target.value)} />
                <datalist id="goal-contract-groups">
                    {allContractGroups.map(g => <option key={g} value={g} />)}
                </datalist>
                <input type="month" value={monthGoal} onChange={e => setMonthGoal(e.target.value)} />
                <input type="number" placeholder="Meta de Medição (m² ou m linear)" value={targetAreaGoal} onChange={e => setTargetAreaGoal(e.target.value)} />
                <button className="button admin-button" onClick={handleSaveGoal}>{editingIdGoal ? 'Salvar Alterações' : 'Adicionar Meta'}</button>
                {editingIdGoal && <button className="button button-secondary" onClick={resetFormGoal}>Cancelar Edição</button>}
            </div>

            <ul className="goal-list">
                {[...goals].sort((a, b) => b.month.localeCompare(a.month) || a.contractGroup.localeCompare(b.contractGroup)).map(goal => {
                    const realizedArea = records.filter(r => r.contractGroup === goal.contractGroup && r.startTime.startsWith(goal.month)).reduce((sum, r) => sum + (r.locationArea || 0), 0);
                    const percentage = goal.targetArea > 0 ? (realizedArea / goal.targetArea) * 100 : 0;
                    return (
                        <li key={goal.id} className="card list-item progress-card">
                            <div className="list-item-header">
                                <h3>{goal.contractGroup} - {goal.month}</h3>
                                <div>
                                    <button className="button button-sm admin-button" onClick={() => handleEditGoal(goal)}>Editar</button>
                                    <button className="button button-sm button-danger" onClick={() => handleDeleteGoal(goal.id)}>Excluir</button>
                                </div>
                            </div>
                            <div className="progress-info">
                                <span>Realizado: {realizedArea.toLocaleString('pt-BR')} / {goal.targetArea.toLocaleString('pt-BR')}</span>
                                <span>{percentage.toFixed(1)}%</span>
                            </div>
                            <div className="progress-bar-container"><div className="progress-bar" style={{ width: `${Math.min(percentage, 100)}%` }}></div></div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

const ServiceInProgressView: React.FC<{ service: Partial<ServiceRecord>; onFinish: () => void; }> = ({ service, onFinish }) => {
    return (
        <div className="card">
            <h2>Serviço em Andamento</h2>
            <div className="detail-section" style={{ textAlign: 'left', marginBottom: '1.5rem' }}>
                <p><strong>Contrato/Cidade:</strong> {service.contractGroup}</p>
                <p><strong>Serviço:</strong> {service.serviceType}</p>
                <p><strong>Local:</strong> {service.locationName}</p>
                <p><strong>Início:</strong> {service.startTime ? formatDateTime(service.startTime) : 'N/A'}</p>
            </div>
            <p>O registro inicial e as fotos "Antes" foram salvos. Complete o serviço no local.</p>
            <p>Quando terminar, clique no botão abaixo para tirar as fotos "Depois".</p>
            <button className="button button-success" style={{ marginTop: '1.5rem' }} onClick={onFinish}>
                ✅ Finalizar e Tirar Fotos "Depois"
            </button>
        </div>
    );
};

const AdminEditRecordView: React.FC<{
    record: ServiceRecord;
    onSave: (updatedRecord: ServiceRecord) => void;
    onCancel: () => void;
    setIsLoading: React.Dispatch<React.SetStateAction<string | null>>;
    currentUser: User | null;
}> = ({ record, onSave, onCancel, setIsLoading, currentUser }) => {
    const [formData, setFormData] = useState<ServiceRecord>(record);
    const isOperator = currentUser?.role === 'OPERATOR';

    const handleChange = (field: keyof ServiceRecord, value: any) => {
        setFormData(prev => ({ ...prev, [field]: value }));
    };

    const handleSave = async () => {
        setIsLoading("Salvando alterações...");
        try {
            const updated = await apiFetch(`/api/records/${formData.id}`, {
                method: 'PUT',
                body: JSON.stringify(formData),
            });
            const fullRecord = {
                ...updated,
                id: String(updated.id),
                operatorId: String(updated.operatorId),
            };
            onSave(fullRecord);
            alert("Registro atualizado com sucesso!");
        } catch (e) {
            alert("Erro ao atualizar registro.");
            console.error(e);
        } finally {
            setIsLoading(null);
        }
    };

    const handlePhotoUpload = async (phase: 'BEFORE' | 'AFTER', files: FileList | null) => {
        if (!files || files.length === 0) return;
        setIsLoading("Enviando fotos...");
        const formDataUpload = new FormData();
        formDataUpload.append("phase", phase);
        Array.from(files).forEach(file => formDataUpload.append("files", file));
        try {
            const updated = await apiFetch(`/api/records/${formData.id}/photos`, {
                method: "POST",
                body: formDataUpload
            });
            const fullRecord = {
                ...updated,
                id: String(updated.id),
                operatorId: String(updated.operatorId),
            };
            setFormData(fullRecord);
        } catch (err) {
            alert(`Falha ao enviar fotos '${phase === "BEFORE" ? "Antes" : "Depois"}'.`);
            console.error(err);
        } finally {
            setIsLoading(null);
        }
    };

    const handlePhotoRemove = async (photoUrl: string) => {
        if (!window.confirm("Tem certeza que deseja remover esta foto?")) return;
        setIsLoading("Removendo foto...");
        try {
            const isBefore = (formData.beforePhotos || []).includes(photoUrl);
            const newBefore = isBefore ? (formData.beforePhotos || []).filter(p => p !== photoUrl) : formData.beforePhotos;
            const newAfter = !isBefore ? (formData.afterPhotos || []).filter(p => p !== photoUrl) : formData.afterPhotos;

            const updated = await apiFetch(`/api/records/${formData.id}`, {
                method: "PUT",
                body: JSON.stringify({
                    beforePhotos: newBefore,
                    afterPhotos: newAfter,
                })
            });
            const fullRecord = {
                ...updated,
                id: String(updated.id),
                operatorId: String(updated.operatorId),
            };
            setFormData(fullRecord);
        } catch (err) {
            alert(`Falha ao remover foto.`);
            console.error(err);
        } finally {
            setIsLoading(null);
        }
    };

    return (
        <div className="card edit-form-container">
            <h3>{isOperator ? 'Adicionar Fotos/Informações' : 'Editar Registro de Serviço'}</h3>
            <div className="form-group">
                <label>Nome do Local</label>
                <input
                    type="text"
                    value={formData.locationName}
                    onChange={e => handleChange("locationName", e.target.value)}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Tipo de Serviço</label>
                <input
                    type="text"
                    value={formData.serviceType}
                    onChange={e => handleChange("serviceType", e.target.value)}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Medição ({formData.serviceUnit})</label>
                <input
                    type="number"
                    value={formData.locationArea || ''}
                    onChange={e => handleChange("locationArea", parseFloat(e.target.value) || 0)}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Unidade</label>
                <select
                    value={formData.serviceUnit}
                    onChange={e => handleChange("serviceUnit", e.target.value as 'm²' | 'm linear')}
                    disabled={isOperator}
                >
                    <option value="m²">m²</option>
                    <option value="m linear">m linear</option>
                </select>
            </div>

            <div className="form-group">
                <label>Contrato/Cidade</label>
                <input
                    type="text"
                    value={formData.contractGroup}
                    onChange={e => handleChange("contractGroup", e.target.value)}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Início</label>
                <input
                    type="datetime-local"
                    value={formData.startTime ? new Date(new Date(formData.startTime).getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 16) : ""}
                    onChange={e => handleChange("startTime", new Date(e.target.value).toISOString())}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Fim</label>
                <input
                    type="datetime-local"
                    value={formData.endTime ? new Date(new Date(formData.endTime).getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 16) : ""}
                    onChange={e => handleChange("endTime", new Date(e.target.value).toISOString())}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <h4>Fotos "Antes" ({(formData.beforePhotos || []).length})</h4>
                <div className="edit-photo-gallery">
                    {(formData.beforePhotos || []).map((p, i) => (
                        <div key={`b-${i}`} className="edit-photo-item">
                            <img src={`${API_BASE}${p}`} alt={`Antes ${i + 1}`} />
                            <button
                                className="delete-photo-btn"
                                onClick={() => handlePhotoRemove(p)}
                            >
                                &times;
                            </button>
                        </div>
                    ))}
                </div>
                <label htmlFor="before-upload" className="button button-sm" style={{ marginTop: '0.5rem' }}>Adicionar Foto "Antes"</label>
                <input
                    id="before-upload"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={e => handlePhotoUpload("BEFORE", e.target.files)}
                    style={{ display: 'none' }}
                />
            </div>

            <div className="form-group">
                <h4>Fotos "Depois" ({(formData.afterPhotos || []).length})</h4>
                <div className="edit-photo-gallery">
                    {(formData.afterPhotos || []).map((p, i) => (
                        <div key={`a-${i}`} className="edit-photo-item">
                            <img src={`${API_BASE}${p}`} alt={`Depois ${i + 1}`} />
                            <button
                                className="delete-photo-btn"
                                onClick={() => handlePhotoRemove(p)}
                            >
                                &times;
                            </button>
                        </div>
                    ))}
                </div>
                <label htmlFor="after-upload" className="button button-sm" style={{ marginTop: '0.5rem' }}>Adicionar Foto "Depois"</label>
                <input
                    id="after-upload"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={e => handlePhotoUpload("AFTER", e.target.files)}
                    style={{ display: 'none' }}
                />
            </div>

            <div className="button-group">
                <button className="button button-secondary" onClick={onCancel}>Voltar</button>
                <button className="button button-success" onClick={handleSave}>Salvar Alterações</button>
            </div>
        </div>
    );
};

const AuditLogView: React.FC<{ log: AuditLogEntry[] }> = ({ log }) => {

    const handleExportPdf = () => {
        const doc = new jsPDF();
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(18);
        doc.text('Log de Auditoria - CRB Serviços', 14, 22);

        let y = 35;
        const pageMargin = 14;
        const pageWidth = doc.internal.pageSize.getWidth() - (pageMargin * 2);

        log.forEach(entry => {
            if (y > 270) {
                doc.addPage();
                y = 20;
            }
            doc.setFontSize(12);
            doc.setFont('Helvetica', 'bold');
            doc.text(`Data: ${formatDateTime(entry.timestamp)}`, pageMargin, y);
            y += 7;

            doc.setFontSize(10);
            doc.setFont('Helvetica', 'normal');

            const details = [
                `Usuário: ${entry.adminUsername}`,
                `Ação: ${entry.action === 'UPDATE' ? 'Atualização' : 'Exclusão'}`,
                `ID do Registro: ${entry.recordId}`,
                `Detalhes: ${entry.details}`
            ];

            details.forEach(line => {
                const splitText = doc.splitTextToSize(line, pageWidth);
                doc.text(splitText, pageMargin, y);
                y += (splitText.length * 5);
            });

            y += 5;
            doc.setDrawColor(200);
            doc.line(pageMargin, y, pageWidth + pageMargin, y);
            y += 10;
        });

        doc.save(`log_auditoria_crb_${new Date().toISOString().split('T')[0]}.pdf`);
    };

    return (
        <div>
            <div className="audit-log-header">
                <h2>Registros de Alterações (Local)</h2>
                <button className="button admin-button" onClick={handleExportPdf} disabled={log.length === 0}>
                    Exportar para PDF
                </button>
            </div>
            {log.length === 0 ? (
                <p>Nenhuma alteração administrativa foi registrada ainda.</p>
            ) : (
                <ul className="audit-log-list">
                    {log.map(entry => (
                        <li key={entry.id} className="audit-log-item">
                            <p><strong>Data:</strong> {formatDateTime(entry.timestamp)}</p>
                            <p><strong>Usuário:</strong> {entry.adminUsername}</p>
                            <p><strong>Ação:</strong> {entry.action === 'UPDATE' ? 'Atualização de Registro' : 'Exclusão de Registro'}</p>
                            <p><strong>ID do Registro:</strong> {entry.recordId}</p>
                            <p><strong>Detalhes:</strong> {entry.details}</p>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

const ManageServicesView: React.FC<{
    services: ServiceDefinition[];
    fetchData: () => Promise<void>;
}> = ({ services, fetchData }) => {
    // ... (estados anteriores)
    const [units, setUnits] = useState<Unit[]>([]);
    const [unitName, setUnitName] = useState('');
    const [unitSymbol, setUnitSymbol] = useState('');
    const [editingUnitId, setEditingUnitId] = useState<string | null>(null);

    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const fetchUnits = async () => {
            try {
                const fetchedUnits = await apiFetch('/api/units');
                setUnits(fetchedUnits.map((u: any) => ({ ...u, id: String(u.id) })));
            } catch (error) {
                console.error("Failed to fetch units", error);
                alert("Não foi possível carregar as unidades de medida.");
            }
        };
        fetchUnits();
    }, []);

    // --- LÓGICA PARA UNIDADES ---
    const resetUnitForm = () => {
        setUnitName('');
        setUnitSymbol('');
        setEditingUnitId(null);
    };

    const handleSaveUnit = async () => {
        if (!unitName.trim() || !unitSymbol.trim()) {
            alert('Nome e Símbolo da unidade são obrigatórios.');
            return;
        }
        setIsLoading(true);
        try {
            const payload = { name: unitName, symbol: unitSymbol };

            if (editingUnitId) {
                await apiFetch(`/api/units/${editingUnitId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/units', { method: 'POST', body: JSON.stringify(payload) });
            }

            resetUnitForm();
            await fetchData();
            const fetchedUnits = await apiFetch('/api/units');
            setUnits(fetchedUnits.map((u: any) => ({ ...u, id: String(u.id) })));
        } catch (error: any) {
            alert('Falha ao salvar a unidade.');
            console.error(error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleEditUnit = (unit: Unit) => {
        setEditingUnitId(unit.id);
        setUnitName(unit.name);
        setUnitSymbol(unit.symbol);
    };

    const handleDeleteUnit = async (id: string) => {
        if (window.confirm('Excluir esta unidade? Ela não pode estar em uso por nenhum serviço.')) {
            setIsLoading(true);
            try {
                await apiFetch(`/api/units/${id}`, { method: 'DELETE' });
                await fetchData();
                const fetchedUnits = await apiFetch('/api/units');
                setUnits(fetchedUnits.map((u: any) => ({ ...u, id: String(u.id) })));
            } catch (error: any) {
                alert(`Falha ao excluir: ${error.message}`);
            } finally {
                setIsLoading(false);
            }
        }
    };

    // --- LÓGICA PARA SERVIÇOS ---
    const resetServiceForm = () => {
        setServiceName('');
        setSelectedUnitId('');
        setEditingServiceId(null);
    };

    const handleSaveService = async () => {
        if (!serviceName.trim() || !selectedUnitId) {
            alert('Nome do serviço e unidade são obrigatórios.');
            return;
        }
        setIsLoading(true);
        try {
            const payload = { name: serviceName, unitId: parseInt(selectedUnitId, 10) };

            if (editingServiceId) {
                await apiFetch(`/api/services/${editingServiceId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/services', { method: 'POST', body: JSON.stringify(payload) });
            }
            resetServiceForm();
            await fetchData();
        } catch (error) {
            alert('Falha ao salvar o serviço.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleEditService = (service: ServiceDefinition) => {
        setEditingServiceId(service.id);
        setServiceName(service.name);
        setSelectedUnitId(String(service.unit.id));
    };

    const handleDeleteService = async (id: string) => {
        if (window.confirm('Excluir este tipo de serviço?')) {
            setIsLoading(true);
            try {
                await apiFetch(`/api/services/${id}`, { method: 'DELETE' });
                await fetchData();
            } catch (error: any) {
                alert(`Falha ao excluir: ${error.message}`);
            } finally {
                setIsLoading(false);
            }
        }
    };

    return (
        <div>
            {/* Seção 1: Gerenciamento de Unidades de Medida */}
            <div className="card">
                <h3>Gerenciar Unidades de Medida</h3>
                <div className="form-container add-service-form" style={{ alignItems: 'flex-end' }}>
                    <input type="text" placeholder="Nome da Unidade (ex: Horas)" value={unitName} onChange={e => setUnitName(e.target.value)} />
                    <input type="text" placeholder="Símbolo (ex: h)" value={unitSymbol} onChange={e => setUnitSymbol(e.target.value)} style={{ flexGrow: 0, width: '100px' }} />
                    <button className="button admin-button" onClick={handleSaveUnit} disabled={isLoading}>
                        {editingUnitId ? 'Salvar' : 'Adicionar'}
                    </button>
                    {editingUnitId && <button className="button button-secondary" onClick={resetUnitForm}>Cancelar</button>}
                </div>
                <ul className="location-list" style={{ marginTop: '1.5rem' }}>
                    {units.map(u => (
                        <li key={u.id} className="service-definition-item">
                            <span><strong>{u.name}</strong> ({u.symbol})</span>
                            <div>
                                <button className="button button-sm admin-button" onClick={() => handleEditUnit(u)}>Editar</button>
                                <button className="button button-sm button-danger" onClick={() => handleDeleteUnit(u.id)}>Excluir</button>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Seção 2: Gerenciamento de Tipos de Serviço */}
            <div className="card" style={{ marginTop: '2rem' }}>
                <h3>Gerenciar Tipos de Serviço</h3>
                <div className="form-container add-service-form" style={{ alignItems: 'flex-end' }}>
                    <input type="text" placeholder="Nome do Serviço" value={serviceName} onChange={e => setServiceName(e.target.value)} />
                    <select value={selectedUnitId} onChange={e => setSelectedUnitId(e.target.value)}>
                        <option value="">Selecione uma unidade</option>
                        {units.map(unit => (
                            <option key={unit.id} value={unit.id}>
                                {unit.name} ({unit.symbol})
                            </option>
                        ))}
                    </select>
                    <button className="button admin-button" onClick={handleSaveService} disabled={isLoading}>
                        {editingServiceId ? 'Salvar Serviço' : 'Adicionar Serviço'}
                    </button>
                    {editingServiceId && <button className="button button-secondary" onClick={resetServiceForm}>Cancelar</button>}
                </div>
                <ul classNameão="location-list" style={{ marginTop: '1.5rem' }}>
                    {services.sort((a, b) => a.name.localeCompare(b.name)).map(s => (
                        <li key={s.id} className="service-definition-item">
                            <span><strong>{s.name}</strong> (Unidade: {s.unit.symbol})</span>
                            <div>
                                <button className="button button-sm admin-button" onClick={() => handleEditService(s)}>Editar</button>
                                <button className="button button-sm button-danger" onClick={() => handleDeleteService(s.id)}>Excluir</button>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

// --- Componente Principal ---
const App = () => {
    const [view, setView] = useState<View>('LOGIN');
    const [currentUser, setCurrentUser] = useLocalStorage<User | null>('crbCurrentUser', null);

    const [users, setUsers] = useState<User[]>([]);
    const [locations, setLocations] = useState<LocationRecord[]>([]);
    const [records, setRecords] = useState<ServiceRecord[]>([]);
    const [services, setServices] = useState<ServiceDefinition[]>([]);
    const [contractConfigs, setContractConfigs] = useState<ContractConfig[]>([]);
    const [goals, setGoals] = useLocalStorage<Goal[]>('crbGoals', []);
    const [auditLog, setAuditLog] = useLocalStorage<AuditLogEntry[]>('crbAuditLog', []);

    const [currentService, setCurrentService] = useLocalStorage<Partial<ServiceRecord>>('crbCurrentService', {});
    const [selectedRecord, setSelectedRecord] = useState<ServiceRecord | null>(null);
    const [selectedContractGroup, setSelectedContractGroup] = useState<string | null>(null);
    const [selectedLocation, setSelectedLocation] = useState<LocationRecord | null>(null);
    const [history, setHistory] = useState<View[]>([]);
    const [isLoading, setIsLoading] = useState<string | null>(null);

    const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());

    const handleToggleRecordSelection = (recordId: string) => {
        setSelectedRecordIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(recordId)) {
                newSet.delete(recordId);
            } else {
                newSet.add(recordId);
            }
            return newSet;
        });
    };

    const handleDeleteSelectedRecords = async () => {
        if (selectedRecordIds.size === 0) return;
        if (window.confirm(`Tem certeza que deseja excluir os ${selectedRecordIds.size} registros selecionados?`)) {
            setIsLoading("Excluindo registros...");
            try {
                const deletePromises = Array.from(selectedRecordIds).map(id =>
                    apiFetch(`/api/records/${id}`, { method: 'DELETE' })
                );
                await Promise.all(deletePromises);

                setRecords(prev => prev.filter(r => !selectedRecordIds.has(r.id)));
                setSelectedRecordIds(new Set());
                alert("Registros excluídos com sucesso.");
            } catch (e) {
                alert("Falha ao excluir um ou mais registros.");
                console.error(e);
            } finally {
                setIsLoading(null);
            }
        }
    };

    useEffect(() => {
        const handleSyncSuccess = (event: Event) => {
            const { tempId, newId } = (event as CustomEvent).detail;
            setCurrentService(prev => {
                if (prev.id === tempId || prev.tempId === tempId) {
                    console.log(`ID do serviço atualizado de ${tempId} para ${newId}`);
                    return { ...prev, id: String(newId) };
                }
                return prev;
            });
        };
        window.addEventListener('syncSuccess', handleSyncSuccess);
        return () => {
            window.removeEventListener('syncSuccess', handleSyncSuccess);
        };
    }, [setCurrentService]);

    const navigate = (newView: View, replace = false) => {
        if (!replace) setHistory(h => [...h, view]);
        setView(newView);
    }

    const handleBack = () => {
        const lastView = history.pop();
        if (lastView) {
            setHistory([...history]);
            setView(lastView);
        } else if (currentUser) {
            redirectUser(currentUser);
        }
    }

    const redirectUser = (user: User) => {
        if (user.role === 'ADMIN') {
            navigate('ADMIN_DASHBOARD', true);
        } else if (user.role === 'OPERATOR') {
            navigate('OPERATOR_GROUP_SELECT', true);
        } else if (user.role === 'FISCAL') {
            navigate('FISCAL_DASHBOARD', true);
        }
    };

    const handleLogout = () => {
        setCurrentUser(null);
        setApiToken(null);
        setHistory([]);
        setSelectedContractGroup(null);
        setSelectedLocation(null);
        setCurrentService({});
        setLocations([]);
        setRecords([]);
        setUsers([]);
        navigate('LOGIN', true);
    }

    const fetchData = async () => {
        if (!currentUser) return;
        setIsLoading('Carregando dados...');
        try {
            const apiEndpoints: Promise<any>[] = [
                apiFetch(`/api/locations?timestamp=${new Date().getTime()}`),
                apiFetch(`/api/records?timestamp=${new Date().getTime()}`),
                apiFetch(`/api/services?timestamp=${new Date().getTime()}`),
                apiFetch('/api/contract-configs'),
            ];
            if (currentUser.role === 'ADMIN') {
                apiEndpoints.push(apiFetch('/api/users'));
            }
            const results = await Promise.all(apiEndpoints);
            const [locs, recs, srvs, configs, usrs] = results;

            setLocations(locs.map((l: any) => ({
                ...l,
                id: String(l.id),
                services: (l.services || []).map((s: any) => ({
                    ...s,
                    serviceId: String(s.serviceId)
                }))
            })));

            setServices(srvs.map((s: any) => ({ ...s, id: String(s.id), unitId: String(s.unitId) })));

            setContractConfigs(configs || []);

            const mapRecord = (r: any) => ({
                ...r,
                id: String(r.id),
                operatorId: String(r.operatorId),
                locationId: r.locationId ? String(r.locationId) : undefined
            });

            if (currentUser.role === 'ADMIN') {
                setRecords(recs.map(mapRecord));
                if (usrs) setUsers(usrs.map((u: any) => ({ ...u, id: String(u.id), username: u.name })));
            } else if (currentUser.role === 'OPERATOR') {
                setRecords(recs.filter((r: any) => String(r.operatorId) === String(currentUser.id)).map(mapRecord));
            } else {
                const fiscalGroups = currentUser.assignments?.map(a => a.contractGroup) || [];
                setRecords(recs.filter((r: any) => fiscalGroups.includes(r.contractGroup)).map(mapRecord));
            }

        } catch (error) {
            console.error("Failed to fetch data", error);
            alert("Não foi possível carregar os dados do servidor.");
            handleLogout();
        } finally {
            setIsLoading(null);
        }
    };

    useEffect(() => {
        const restoreSession = async () => {
            if (API_TOKEN) {
                setIsLoading("Verificando sessão...");
                try {
                    const me = await apiFetch('/api/auth/me');
                    const user: User = { id: String(me.id), username: me.name, email: me.email, role: me.role, assignments: me.assignments || [] };
                    setCurrentUser(user);
                    if (view === 'LOGIN') {
                        redirectUser(user);
                    }
                } catch (error) {
                    console.error("Session restore failed", error);
                    handleLogout();
                } finally {
                    setIsLoading(null);
                }
            }
        };
        restoreSession();
    }, []);

    useEffect(() => {
        if (currentUser) {
            fetchData();
        }
    }, [currentUser]);

    const resetService = () => {
        setCurrentService({});
        setSelectedContractGroup(null);
        setSelectedLocation(null);
        redirectUser(currentUser!);
    }

    const handleLogin = (user: User) => {
        setCurrentUser(user);
        redirectUser(user);
    };

    const handleBackup = () => {
        alert("O backup agora deve ser realizado diretamente no servidor/banco de dados.");
    };

    const handleRestore = () => {
        alert("A restauração de dados agora deve ser realizada diretamente no servidor/banco de dados.");
    };

    const handleGroupSelect = (group: string) => {
        setSelectedContractGroup(group);
        navigate('OPERATOR_LOCATION_SELECT');
    }

    const handleLocationSelect = (location: LocationRecord, service: ServiceDefinition | null, measurement: number | null, gpsUsed: boolean) => {
        setSelectedLocation(location);
        
        // Se um serviço foi selecionado no passo anterior (criação de local manual)
        if (service) {
            setCurrentService({
                serviceType: service.name,
                serviceUnit: service.unit.symbol,
                contractGroup: location.contractGroup,
                locationId: location.id.startsWith('manual-') ? undefined : location.id,
                locationName: location.name,
                locationArea: measurement,
                gpsUsed: gpsUsed,
                // Adiciona o coords para a requisição POST futura
                coords: location.coords,
            });
            navigate('PHOTO_STEP');
        } else {
            // Se for um local existente, continua para a próxima tela
            navigate('OPERATOR_SERVICE_SELECT');
        }
    };

    const handleServiceSelect = (service: ServiceDefinition) => {
        if (!selectedLocation) return;
        const config = contractConfigs.find(c => c.contractGroup === selectedLocation.contractGroup);
        const cycleStartDay = config ? config.cycleStartDay : 1;
        const today = new Date();
        let cycleStartDate = new Date(today.getFullYear(), today.getMonth(), cycleStartDay);
        if (today.getDate() < cycleStartDay) {
            cycleStartDate.setMonth(cycleStartDate.getMonth() - 1);
        }
        cycleStartDate.setHours(0, 0, 0, 0);

        const existingRecord = records.find(record =>
            record.locationId === selectedLocation.id &&
            record.serviceType === service.name &&
            new Date(record.startTime) >= cycleStartDate
        );

        if (existingRecord) {
            console.log("Reabrindo registro para adicionar fotos:", existingRecord.id);
            setCurrentService(existingRecord);
            navigate('PHOTO_STEP');
        } else {
            console.log("Iniciando novo registro para o serviço:", service.name);
            const serviceDetail = selectedLocation.services?.find(s => s.serviceId === service.id);
            if (!serviceDetail) {
                alert("Erro: Este serviço não está configurado para este local. Por favor, contate o administrador.");
                return;
            }

            setCurrentService({
                serviceType: service.name,
                serviceUnit: service.unit.symbol,
                contractGroup: selectedLocation.contractGroup,
                locationId: selectedLocation.id.startsWith('manual-') ? undefined : selectedLocation.id,
                locationName: selectedLocation.name,
                locationArea: serviceDetail.measurement,
                gpsUsed: (selectedLocation as any)._gpsUsed || false,
            });
            navigate('PHOTO_STEP');
        }
    };

    const handleBeforePhotos = async (photosBefore: string[]) => {
        setIsLoading("Criando registro e salvando fotos 'Antes'...");
        try {
            let locationId = currentService.locationId;
            let locationName = currentService.locationName;
            let contractGroup = currentService.contractGroup;

            if (locationName && !locationId) {
                const serviceId = services.find(s => s.name === currentService.serviceType)?.id;
                const measurement = currentService.locationArea;
                
                if (!serviceId || measurement === undefined || measurement === null) {
                     alert("Erro: Informações de serviço e medição ausentes para novo local.");
                     throw new Error("Dados de serviço incompletos para novo local.");
                }

                const newLocation = await apiFetch('/api/locations', {
                    method: 'POST',
                    body: JSON.stringify({
                        city: contractGroup,
                        name: locationName,
                        lat: currentService.gpsUsed && currentService.coords ? currentService.coords.latitude : undefined,
                        lng: currentService.gpsUsed && currentService.coords ? currentService.coords.longitude : undefined,
                        services: [{
                            service_id: serviceId,
                            measurement: measurement
                        }]
                    })
                });
                locationId = String(newLocation.id);
            }

            const recordPayload = {
                operatorId: parseInt(currentUser!.id, 10),
                serviceType: currentService.serviceType,
                serviceUnit: currentService.serviceUnit,
                locationId: locationId ? parseInt(locationId, 10) : undefined,
                locationName: currentService.locationName,
                contractGroup: currentService.contractGroup,
                locationArea: currentService.locationArea,
                gpsUsed: !!currentService.gpsUsed,
                startTime: new Date().toISOString(),
                tempId: crypto.randomUUID()
            };

            const beforeFiles = photosBefore.map((p, i) =>
                dataURLtoFile(p, `before_${i}.jpg`)
            );

            await queueRecord(recordPayload, beforeFiles);

            setCurrentService(prev => ({
                ...prev,
                ...recordPayload,
                id: recordPayload.tempId,
                locationId: recordPayload.locationId ? String(recordPayload.locationId) : undefined,
            }));

            navigate('OPERATOR_SERVICE_IN_PROGRESS');

        } catch (err) {
            console.error(err);
            alert("Falha ao salvar registro local.");
        } finally {
            setIsLoading(null);
        }
    };

    const handleAfterPhotos = async (photosAfter: string[]) => {
        setIsLoading("Salvando fotos 'Depois'...");
        try {
            const afterFiles = photosAfter.map((p, i) =>
                dataURLtoFile(p, `after_${i}.jpg`)
            );

            await addAfterPhotosToPending(currentService.tempId || currentService.id!, afterFiles);

            navigate('CONFIRM_STEP');

        } catch (err) {
            console.error(err);
            alert("Falha ao salvar fotos localmente.");
        } finally {
            setIsLoading(null);
        }
    };

    const handleSave = () => {
        alert("Registro salvo com sucesso.");
        fetchData();
        resetService();
    };

    const handleSelectRecord = async (record: ServiceRecord) => {
        setIsLoading("Carregando detalhes...");
        try {
            const detailedRecord = await apiFetch(`/api/records/${record.id}`);
            const fullRecord = {
                ...detailedRecord,
                id: String(detailedRecord.id),
                operatorId: String(detailedRecord.operatorId),
            };
            setSelectedRecord(fullRecord);
            navigate('DETAIL');
        } catch (e) {
            alert('Não foi possível carregar os detalhes do registro.');
        } finally {
            setIsLoading(null);
        }
    }

    const handleEditRecord = async (record: ServiceRecord) => {
        setIsLoading("Carregando registro para edição...");
        try {
            const detailedRecord = await apiFetch(`/api/records/${record.id}`);
            const fullRecord = {
                ...detailedRecord,
                id: String(detailedRecord.id),
                operatorId: String(detailedRecord.operatorId),
            };
            setSelectedRecord(fullRecord);
            navigate('ADMIN_EDIT_RECORD');
        } catch (e) {
            alert('Não foi possível carregar o registro para edição.');
        } finally {
            setIsLoading(null);
        }
    };

    const handleUpdateRecord = (updatedRecord: ServiceRecord) => {
        setRecords(prev => prev.map(r => r.id === updatedRecord.id ? { ...r, ...updatedRecord } : r));
        handleBack();
    };

    const handleDeleteRecord = async (recordId: string) => {
        if (!currentUser || currentUser.role !== 'ADMIN') return;

        const recordToDelete = records.find(r => r.id === recordId);
        if (!recordToDelete) return;

        if (window.confirm(`Tem certeza que deseja excluir o registro do local "${recordToDelete.locationName}"?`)) {
            try {
                setIsLoading("Excluindo registro...");
                await apiFetch(`/api/records/${recordId}`, { method: 'DELETE' });
                setRecords(prev => prev.filter(r => r.id !== recordId));
                alert("Registro excluído com sucesso.");
            } catch (e) {
                alert("Falha ao excluir o registro.");
                console.error(e);
            } finally {
                setIsLoading(null);
            }
        }
    };

    const renderView = () => {
        if (!currentUser && view !== 'LOGIN') {
            return <Loader text="Verificando sessão..." />;
        }
        if (!currentUser) {
            return <Login onLogin={handleLogin} />;
        }

        switch (currentUser.role) {
            case 'ADMIN':
                switch (view) {
                    case 'ADMIN_DASHBOARD': return <AdminDashboard onNavigate={navigate} />;
                    case 'ADMIN_MANAGE_SERVICES': return <ManageServicesView services={services} fetchData={fetchData} />;
                    case 'ADMIN_MANAGE_LOCATIONS': return <ManageLocationsView locations={locations} services={services} fetchData={fetchData} />;
                    case 'ADMIN_MANAGE_USERS': return <ManageUsersView users={users} onUsersUpdate={fetchData} services={services} locations={locations} />;
                    case 'ADMIN_MANAGE_GOALS': return <GoalsAndChartsView records={records} locations={locations} />;
                    case 'ADMIN_MANAGE_CYCLES': return <ManageCyclesView locations={locations} configs={contractConfigs} fetchData={fetchData} />;
                    case 'REPORTS': return <ReportsView records={records} services={services} />;
                    case 'HISTORY': return <HistoryView records={records} onSelect={handleSelectRecord} isAdmin={true} onEdit={handleEditRecord} onDelete={handleDeleteRecord} selectedIds={selectedRecordIds} onToggleSelect={handleToggleRecordSelection} onDeleteSelected={handleDeleteSelectedRecords} />;
                    case 'DETAIL': return selectedRecord ? <DetailView record={selectedRecord} /> : <p>Registro não encontrado.</p>;
                    case 'ADMIN_EDIT_RECORD': return selectedRecord ? <AdminEditRecordView record={selectedRecord} onSave={handleUpdateRecord} onCancel={handleBack} setIsLoading={setIsLoading} currentUser={currentUser} /> : <p>Nenhum registro selecionado para edição.</p>;
                    case 'AUDIT_LOG': return <AuditLogView log={auditLog} />;
                    default: return <AdminDashboard onNavigate={navigate} />;
                }

            case 'FISCAL':
                const fiscalGroups = currentUser.assignments?.map(a => a.contractGroup) || [];
                const fiscalRecords = records.filter(r => fiscalGroups.includes(r.contractGroup));
                switch (view) {
                    case 'FISCAL_DASHBOARD': return <FiscalDashboard onNavigate={navigate} />;
                    case 'REPORTS': return <ReportsView records={fiscalRecords} services={services} />;
                    case 'HISTORY': return <HistoryView records={fiscalRecords} onSelect={handleSelectRecord} isAdmin={false} selectedIds={new Set()} onToggleSelect={() => { }} />;
                    case 'DETAIL':
                        const canView = selectedRecord && fiscalGroups.includes(selectedRecord.contractGroup);
                        return canView ? <DetailView record={selectedRecord} /> : <p>Registro não encontrado ou acesso não permitido.</p>;
                    default: return <FiscalDashboard onNavigate={navigate} />;
                }

            case 'OPERATOR':
                switch (view) {
                    case 'OPERATOR_GROUP_SELECT': return <OperatorGroupSelect user={currentUser} onSelectGroup={handleGroupSelect} />;
                    case 'OPERATOR_LOCATION_SELECT': return selectedContractGroup ? <OperatorLocationSelect locations={locations} contractGroup={selectedContractGroup} onSelectLocation={handleLocationSelect} services={services} currentUser={currentUser} /> : null;
                    case 'OPERATOR_SERVICE_SELECT': return selectedLocation ? <OperatorServiceSelect location={selectedLocation} services={services} user={currentUser} onSelectService={handleServiceSelect} records={records} contractConfigs={contractConfigs} /> : null;
                    case 'OPERATOR_SERVICE_IN_PROGRESS': return <ServiceInProgressView service={currentService} onFinish={() => navigate('PHOTO_STEP')} />;
                    case 'PHOTO_STEP':
                        if (!currentService.id) {
                            return <PhotoStep phase="BEFORE" onComplete={handleBeforePhotos} onCancel={resetService} />;
                        }
                        return <PhotoStep phase="AFTER" onComplete={handleAfterPhotos} onCancel={resetService} />;
                    case 'CONFIRM_STEP': return <ConfirmStep recordData={currentService} onSave={handleSave} onCancel={resetService} />;
                    case 'HISTORY':
                        const operatorRecords = records.filter(r => String(r.operatorId) === String(currentUser.id));
                        return <HistoryView records={operatorRecords} onSelect={handleSelectRecord} isAdmin={false} onEdit={handleEditRecord} selectedIds={new Set()} onToggleSelect={() => { }} />;
                    case 'DETAIL': return selectedRecord ? <DetailView record={selectedRecord} /> : <p>Registro não encontrado.</p>;
                    case 'ADMIN_EDIT_RECORD': return selectedRecord ? <AdminEditRecordView record={selectedRecord} onSave={handleUpdateRecord} onCancel={handleBack} setIsLoading={setIsLoading} currentUser={currentUser} /> : <p>Nenhum registro selecionado para edição.</p>;
                    default: return <OperatorGroupSelect user={currentUser} onSelectGroup={handleGroupSelect} />;
                }

            default:
                handleLogout();
                return null;
        }
    };

    return (
        <div className={`app-container ${view === 'LOGIN' ? 'login-view' : ''}`}>
            {isLoading && (
                <div className="loader-overlay">
                    <div className="spinner"></div>
                    <p>{isLoading}</p>
                </div>
            )}
            <Header view={view} currentUser={currentUser} onBack={handleBack} onLogout={handleLogout} />
            <main>{renderView()}</main>
        </div>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
