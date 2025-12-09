import { getPendingRecords } from "./db"; // <--- Adicione isto
import { queueRecord, addAfterPhotosToPending, addBeforePhotosToPending } from "./syncManager";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import logoSrc from './assets/Logo.png';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend } from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import ResetPasswordView from './ResetPasswordView';
import ForgotPasswordView from './ForgotPasswordView';

ChartJS.register( CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend );

// --- Tipos, Helpers, Hooks ---

// NOVO HELPER: Torna strings insensíveis a maiúsculas/minúsculas e acentos
const normalizeString = (str: string | null | undefined) => {
    if (!str) return '';
    // Converte para minúsculas, normaliza (NFD) para separar a letra do acento, 
    // e remove os caracteres de diacrítico (acentos)
    return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
};

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
    | 'RESET_PASSWORD'
    | 'FORGOT_PASSWORD'
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

interface Unit { id: string; name: string; symbol: string;}
interface ServiceDefinition { id: string; name: string; unit: Unit; unitId: number;}
interface LocationServiceDetail { serviceId: string; name: string; measurement: number; unit: Unit;}
// Nova interface para facilitar a lógica de medição (Correção 3)
interface LocationRecordServiceMap { [locationId: string]: { [serviceId: string]: number; }; } 

interface UserAssignment { contractGroup: string; serviceNames: string[]; }
interface User { id: string; username: string; email?: string; password?: string; role: Role; assignments?: UserAssignment[]; }
interface GeolocationCoords { latitude: number; longitude: number; }
interface LocationRecord { id: string; contractGroup: string; name: string; observations?: string; coords?: GeolocationCoords; services?: LocationServiceDetail[]; parentId?: string | null; isGroup?: boolean; }
interface ServiceRecord {
    id: string; operatorId: string; operatorName: string; serviceType: string; serviceUnit: string;
    locationId?: string; locationName: string; contractGroup: string; locationArea?: number;
    gpsUsed: boolean; startTime: string; endTime: string; beforePhotos: string[]; afterPhotos: string[];
    tempId?: string; coords?: GeolocationCoords;
    observations?: string;
    overrideMeasurement?: number;
    serviceId?: number;
    serviceOrderNumber?: string;
}
interface Goal {
  id: string;
  contractGroup: string;
  month: string;
  targetArea: number;
  serviceId: number;
}
interface AuditLogEntry { id: string; timestamp: string; adminId: string; adminUsername: string; action: 'UPDATE' | 'DELETE' | 'ADJUST_MEASUREMENT'; recordId: string; details: string; }
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

// --- Ícones SVG ---
const Icons = {
    Search: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    ChevronLeft: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
    ChevronRight: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
};

// --- Componentes UI Reutilizáveis ---
const Pagination: React.FC<{ currentPage: number; totalPages: number; onPageChange: (page: number) => void }> = ({ currentPage, totalPages, onPageChange }) => {
    if (totalPages <= 1) return null;
    return (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '1rem', padding: '1rem 0' }}>
            <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1} className="button button-sm button-secondary">
                <Icons.ChevronLeft />
            </button>
            <span style={{ fontSize: '0.9rem', color: 'var(--dark-gray-color)' }}>Página {currentPage} de {totalPages}</span>
            <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages} className="button button-sm button-secondary">
                <Icons.ChevronRight />
            </button>
        </div>
    );
};

const SearchBar: React.FC<{ value: string; onChange: (val: string) => void; placeholder?: string }> = ({ value, onChange, placeholder = "Buscar..." }) => (
    <div style={{ position: 'relative', marginBottom: '1rem' }}>
        <input
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{ width: '100%', padding: '0.75rem 0.75rem 0.75rem 2.5rem', borderRadius: '8px', border: '1px solid #ddd' }}
        />
        <div style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#888' }}>
            <Icons.Search />
        </div>
    </div>
);

// Componente para visualização de imagem em tela cheia (Correção 1)
const ImageViewer: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
    if (!src) return null;
    
    return (
        <div 
            style={{ 
                position: 'fixed', 
                top: 0, 
                left: 0, 
                width: '100%', 
                height: '100%', 
                backgroundColor: 'rgba(0, 0, 0, 0.9)', 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                zIndex: 1000,
                cursor: 'pointer'
            }}
            onClick={onClose}
        >
            <img 
                src={src} 
                alt="Visualização em tela cheia" 
                style={{ 
                    maxWidth: '90%', 
                    maxHeight: '90%', 
                    objectFit: 'contain'
                }} 
                onClick={e => e.stopPropagation()} // Impede que o clique na imagem feche
            />
             <button 
                onClick={onClose} 
                style={{ 
                    position: 'absolute', 
                    top: '20px', 
                    right: '20px', 
                    fontSize: '30px', 
                    color: 'white', 
                    background: 'none', 
                    border: 'none', 
                    cursor: 'pointer' 
                }}
            >&times;</button>
        </div>
    );
};


// --- Componentes ---

const Header: React.FC<{ view: View; currentUser: User | null; onBack?: () => void; onLogout: () => void; }> = ({ view, currentUser, onBack, onLogout }) => {
    const isAdmin = currentUser?.role === 'ADMIN';
    const showBackButton = onBack && view !== 'LOGIN' && view !== 'ADMIN_DASHBOARD' && view !== 'FISCAL_DASHBOARD' && view !== 'OPERATOR_GROUP_SELECT';
    
    const getTitle = () => {
        if (!currentUser) return 'CRB SERVIÇOS';
        if (isAdmin) {
            switch(view) {
                case 'ADMIN_DASHBOARD': return 'Painel do Administrador';
                case 'ADMIN_MANAGE_SERVICES': return 'Gerenciar Tipos de Serviço';
                case 'ADMIN_MANAGE_LOCATIONS': return 'Gerenciar Locais';
                case 'ADMIN_MANAGE_USERS': return 'Gerenciar Funcionários';
                case 'ADMIN_MANAGE_GOALS': return 'Metas & Gráficos';
                case 'ADMIN_MANAGE_CYCLES': return 'Gerenciar Ciclos de Medição';
                case 'REPORTS': return 'Gerador de Relatórios';
                case 'HISTORY': return 'Histórico Geral';
                case 'DETAIL': return 'Detalhes do Serviço';
                case 'ADMIN_EDIT_RECORD': return 'Editar Registro de Serviço';
                case 'AUDIT_LOG': return 'Log de Auditoria';
                default: return 'Modo Administrador';
            }
        }
        if (currentUser.role === 'FISCAL') {
             switch(view) {
                case 'FISCAL_DASHBOARD': return 'Painel de Fiscalização';
                case 'REPORTS': return 'Relatórios';
                case 'HISTORY': return 'Histórico de Serviços';
                case 'DETAIL': return 'Detalhes do Serviço';
                default: return 'Modo Fiscalização';
            }
        }
        switch(view) {
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
        </header>
    );
};

const Loader: React.FC<{ text?: string }> = ({ text = "Carregando..." }) => ( <div className="loader-container"><div className="spinner"></div><p>{text}</p></div> );

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
                if (screen.orientation && (screen.orientation as any).lock) { await (screen.orientation as any).lock('landscape'); }
            } catch (err) { console.warn("Não foi possível ativar tela cheia ou travar orientação:", err); }
        };
        enterFullscreen();
        return () => {
            try {
                if (document.fullscreenElement) { document.exitFullscreen(); }
                if (screen.orientation && (screen.orientation as any).unlock) { (screen.orientation as any).unlock(); }
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

const Login: React.FC<{
  onLogin: (user: User) => void;
  onNavigate: (view: View) => void;
}> = ({ onLogin, onNavigate }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleLogin = async () => {
    setError('');
    setMessage('');
    setIsLoading(true);
    try {
      const { access_token } = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      setApiToken(access_token);
      const me = await apiFetch('/api/auth/me');
      const user: User = {
        id: String(me.id),
        username: me.name || me.email,
        email: me.email,
        role: me.role,
        assignments: me.assignments || []
      };
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
      {error && <p className="text-danger">{error}</p>}
      {message && <p className="text-success">{message}</p>}
      <input
        type="email"
        placeholder="E-mail"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="Senha"
        value={password}
        onChange={e => setPassword(e.target.value)}
      />
      <button className="button" onClick={handleLogin} disabled={isLoading}>
        {isLoading ? 'Entrando...' : 'Entrar'}
      </button>
      <button
        className="button button-secondary"
        onClick={() => onNavigate('FORGOT_PASSWORD')}
        disabled={isLoading}
      >
        Esqueci minha senha
      </button>
    </div>
  );
};

const AdminDashboard: React.FC<{ onNavigate: (view: View) => void; onLogout: () => void; }> = ({ onNavigate, onLogout }) => (
    <div className="dashboard-container">
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
        <button className="button button-danger" style={{ marginTop: '2rem' }} onClick={onLogout}>Sair do Sistema</button>
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
            setCycleConfigs(prev => ({...prev, [contractGroup]: day === '' ? 1 : dayAsNumber}));
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
            
            <div className="form-container" style={{gap: '1.5rem', marginTop: '1.5rem', textAlign: 'left'}}>
                {allContractGroups.map(group => (
                    <div key={group} className="form-group">
                        <label htmlFor={`cycle-day-${group}`} style={{fontWeight: 'bold'}}>{group}</label>
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

            <button className="button admin-button" style={{marginTop: '2rem'}} onClick={handleSave} disabled={isLoading}>
                {isLoading ? 'Salvando...' : 'Salvar Configurações'}
            </button>
        </div>
    );
};

const FiscalDashboard: React.FC<{ onNavigate: (view: View) => void; onLogout: () => void; }> = ({ onNavigate, onLogout }) => (
    <div className="dashboard-container">
        <div className="admin-dashboard">
            <button className="button" onClick={() => onNavigate('REPORTS')}>📊 Gerar Relatórios</button>
            {/* Adicionando botão para histórico na dashboard fiscal, se necessário */}
            <button className="button" onClick={() => onNavigate('HISTORY')}>Histórico de Serviços</button>
        </div>
        <button className="button button-danger" style={{ marginTop: '2rem' }} onClick={onLogout}>Sair do Sistema</button>
    </div>
);

const OperatorGroupSelect: React.FC<{
    user: User;
    onSelectGroup: (group: string) => void;
    onLogout: () => void;
}> = ({ user, onSelectGroup, onLogout }) => {
    const assignedGroups = [...new Set(user.assignments?.map(a => a.contractGroup) || [])].sort();
    return (
        <div className="card">
            <h2>Selecione o Contrato/Cidade</h2>
            <div className="city-selection-list">
                {assignedGroups.length > 0 ? assignedGroups.map(group => (
                    <button key={group} className="button" onClick={() => onSelectGroup(group)}>{group}</button>
                )) : <p>Nenhum grupo de trabalho atribuído. Contate o administrador.</p>}
            </div>
            <button className="button button-danger" style={{ marginTop: '2rem' }} onClick={onLogout}>Sair do Sistema</button>
        </div>
    );
};

const OperatorServiceSelect: React.FC<{
    location: LocationRecord;
    services: ServiceDefinition[];
    user: User;
    onSelectService: (service: ServiceDefinition, measurement?: number) => void;
    records: ServiceRecord[];
    contractConfigs: ContractConfig[];
    locations: LocationRecord[];
}> = ({ location, services, user, onSelectService, records, contractConfigs, locations }) => {

    const isManualLocation = location.id.startsWith('manual-');

    const getCurrentCycleStartDate = (contractGroup: string): Date => {
        const config = contractConfigs.find(c => c.contractGroup === contractGroup);
        const cycleStartDay = config ? config.cycleStartDay : 1;
        const today = new Date();
        const currentMonth = today.getMonth();
        const currentYear = today.getFullYear();
        const currentDate = today.getDate();
        let cycleStartDate: Date;
        if (currentDate >= cycleStartDay) {
            cycleStartDate = new Date(currentYear, currentMonth, cycleStartDay);
        } else {
            cycleStartDate = new Date(currentYear, currentMonth - 1, cycleStartDay);
        }
        cycleStartDate.setHours(0, 0, 0, 0);
        return cycleStartDate;
    };

    const getServicesWithStatus = () => {
        const assignment = user.assignments?.find(a => a.contractGroup === location.contractGroup);
        const assignedServiceNames = new Set(assignment?.serviceNames || []);
        
        let servicesForLocation: LocationServiceDetail[] = [];
        if (location.parentId) {
            const parentLocation = locations.find(l => l.id === location.parentId);
            servicesForLocation = parentLocation?.services || [];
        } else {
            servicesForLocation = location.services || [];
        }

        const relevantServices = isManualLocation 
            ? services.filter(s => assignedServiceNames.has(s.name))
            : services.filter(s => servicesForLocation.some(ls => ls.serviceId === s.id));

        if (isManualLocation) {
            return relevantServices.map(service => ({ ...service, status: 'pending' }));
        }

        const cycleStartDate = getCurrentCycleStartDate(location.contractGroup);
        return relevantServices.map(service => {
            const isDone = records.some(record =>
                record.locationId === location.id &&
                record.serviceType === service.name &&
                new Date(record.startTime) >= cycleStartDate
            );
            return { ...service, status: isDone ? 'done' : 'pending' };
        });
    };

    const servicesWithStatus = getServicesWithStatus();
    
    const handleSelect = (service: ServiceDefinition) => {
        if (isManualLocation) {
            const measurementStr = prompt(`Digite a medição para "${service.name}" em ${service.unit.symbol}:`);
            const measurement = parseFloat(measurementStr || '');
            if (measurementStr === null || isNaN(measurement) || measurement <= 0) {
                alert("Medição inválida. Por favor, insira um número válido.");
                return;
            }
            onSelectService(service, measurement);
        } else {
            onSelectService(service);
        }
    };

    return (
        <div className="card">
            <h2>Escolha o Serviço em "{location.name}"</h2>
            <div className="service-selection-list">
                {servicesWithStatus.length === 0 ? (
                    <p>Nenhum serviço atribuído ou configurado para este local. Por favor, contate o administrador.</p>
                ) : (
                    servicesWithStatus.map(service => (
                        <button
                            key={service.id}
                            className="button"
                            onClick={() => handleSelect(service)}
                            style={{ 
                                display: 'flex', 
                                justifyContent: 'space-between', 
                                alignItems: 'center',
                                backgroundColor: service.status === 'done' ? '#cccccc' : ''
                            }}
                        >
                            <span>{service.name} ({service.unit.symbol})</span>
                            {service.status === 'done' ? (
                                <span style={{color: 'green', fontSize: '1.5rem'}}>✅</span>
                            ) : (
                                <span style={{color: '#f0ad4e', fontSize: '1.rem'}}>⚠️</span>
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
    onSelectLocation: (loc: LocationRecord, gpsUsed: boolean) => void;
}> = ({ locations, contractGroup, onSelectLocation }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [gpsLocation, setGpsLocation] = useState<GeolocationCoords | null>(null);
    const [error, setError] = useState<string | null>(null);

    const contractLocations = locations.filter(l => l.contractGroup === contractGroup);

    useEffect(() => {
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const currentCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
                setGpsLocation(currentCoords);
                setError(null);
            },
            (err) => setError('Não foi possível obter a localização GPS.'),
            { enableHighAccuracy: true }
        );
        return () => navigator.geolocation.clearWatch(watchId);
    }, [contractLocations]);

    const handleSelectFromList = (loc: LocationRecord) => {
        onSelectLocation(loc, false);
    };

    const handleAddNewStreet = (parentLocation: LocationRecord) => {
        const streetName = prompt(`Digite o nome da NOVA RUA para o bairro "${parentLocation.name}":`);
        if (streetName && streetName.trim()) {
            const newStreetLocation: LocationRecord = {
                id: `manual-${new Date().getTime()}`,
                name: streetName.trim().toUpperCase(), // Caixa alta para novos locais (Correção 4)
                contractGroup: contractGroup,
                parentId: parentLocation.id,
                coords: gpsLocation || undefined,
                services: []
            };
            onSelectLocation(newStreetLocation, !!gpsLocation);
        }
    };
    
    // Processar locais para criar uma estrutura hierárquica
    const topLevelLocations = contractLocations.filter(l => !l.parentId);
    const childrenMap = contractLocations.reduce((acc, loc) => {
        if (loc.parentId) {
            if (!acc[loc.parentId]) acc[loc.parentId] = [];
            acc[loc.parentId].push(loc);
        }
        return acc;
    }, {} as Record<string, LocationRecord[]>);

    const filteredTopLevel = topLevelLocations.filter(loc => loc.name.toLowerCase().includes(searchQuery.toLowerCase()));

    return (
        <div className="card">
            <h2>Selecione o Local em "{contractGroup}"</h2>
            {error && <p className="text-danger">{error}</p>}
            
            <input type="search" placeholder="Buscar por bairro ou endereço..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{marginBottom: '1rem'}} />
            
            <div className="location-selection-list">
                {filteredTopLevel.length > 0 ? filteredTopLevel.map(loc => {
                    const children = childrenMap[loc.id] || [];
                    const isNeighborhood = loc.isGroup; // Use explicit 'isGroup' flag

                    if (isNeighborhood) {
                        return (
                            <details key={loc.id} style={{marginBottom: '0.5rem'}}>
                                <summary className="button button-secondary location-button-with-obs" style={{width: '100%', textAlign: 'left', cursor: 'pointer'}}>
                                    <span className="location-name">Bairro: {loc.name}</span>
                                    {loc.observations && <span className="location-observation">Obs: {loc.observations}</span>}
                                </summary>
                                <div style={{padding: '0.5rem 0.5rem 0.5rem 1.5rem', borderLeft: '2px solid var(--medium-gray-color)'}}>
                                    {children.map(street => (
                                        <button key={street.id} className="button button-secondary location-button-with-obs" onClick={() => handleSelectFromList(street)} style={{marginBottom: '0.5rem'}}>
                                            <span className="location-name">{street.name}</span>
                                            {street.observations && <span className="location-observation">Obs: {street.observations}</span>}
                                        </button>
                                    ))}
                                    <button className="button button-sm" onClick={() => handleAddNewStreet(loc)}>+ Adicionar Nova Rua</button>
                                </div>
                            </details>
                        )
                    } else { // It's a simple, top-level address
                        return (
                             <button key={loc.id} className="button button-secondary location-button-with-obs" onClick={() => handleSelectFromList(loc)}>
                                <span className="location-name">{loc.name}</span>
                                {loc.observations && <span className="location-observation">Obs: {loc.observations}</span>}
                            </button>
                        )
                    }
                }) : <p>Nenhum local encontrado.</p>}
            </div>
             <div className="card-inset">
                <h4>Não encontrou? Crie um endereço único</h4>
                 <button className="button" onClick={() => handleAddNewStreet({id: 'manual-root', name:'Novo Local Avulso', contractGroup})}>
                    Criar Novo Local Avulso
                </button>
            </div>
        </div>
    );
};


const PhotoStep: React.FC<{ phase: 'BEFORE' | 'AFTER'; onComplete: (photos: string[], serviceOrderNumber?: string) => void; onCancel: () => void }> = ({ phase, onComplete, onCancel }) => {
    const [photos, setPhotos] = useState<string[]>([]);
    const [isTakingPhoto, setIsTakingPhoto] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [serviceOrderNumber, setServiceOrderNumber] = useState('');
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
    const [selectedContractGroup, setSelectedContractGroup] = useState(''); // <--- NOVO ESTADO
    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };
    if(isTakingPhoto) {
        return <CameraView onCapture={handleCapture} onCancel={() => setIsTakingPhoto(false)} onFinish={() => setIsTakingPhoto(false)} photoCount={photos.length} />
    }
    return (
        <div className="card">
            <h2>{title}</h2>
            <p>{instruction}</p>

            {phase === 'BEFORE' && (
                <div className="form-container" style={{marginBottom: '1rem'}}>
                    <label htmlFor="service-order-input" style={{textAlign: 'left', fontWeight: 500}}>Número da Ordem de Serviço (Opcional)</label>
                    <input
                        id="service-order-input"
                        type="text"
                        placeholder="Digite o número da O.S."
                        value={serviceOrderNumber}
                        onChange={(e) => setServiceOrderNumber(e.target.value.toUpperCase())} // Caixa alta para OS (Correção 4)
                        onBlur={(e) => setServiceOrderNumber(e.target.value.toUpperCase())} // Caixa alta para OS (Correção 4)
                    />
                </div>
            )}

            <div className="photo-section">
                <h3>Fotos Capturadas ({photos.length})</h3>
                <div className="photo-gallery">
                    {photos.map((p, i) => <img key={i} src={p} alt={`Foto ${i+1}`} className="image-preview" />)}
                </div>
                <input type="file" ref={fileInputRef} onChange={handleFileSelect} style={{ display: 'none' }} accept="image/*" multiple />
                <div className="photo-actions">
                    <button className="button" onClick={() => setIsTakingPhoto(true)}>📷 {photos.length > 0 ? 'Tirar Outra Foto' : 'Iniciar Captura'}</button>
                    <button className="button button-secondary" onClick={handleUploadClick}>🖼️ Adicionar Foto do Dispositivo</button>
                </div>
            </div>
            <div style={{display: 'flex', gap: '1rem', marginTop: '1rem'}}>
                <button className="button button-danger" onClick={onCancel}>Cancelar</button>
                <button className="button button-success" onClick={() => onComplete(photos, serviceOrderNumber)} disabled={photos.length === 0}>✅ Encerrar Captação</button>
            </div>
        </div>
    );
};

const ConfirmStep: React.FC<{ recordData: Partial<ServiceRecord>; onSave: () => void; onCancel: () => void }> = ({ recordData, onSave, onCancel }) => (
    <div className="card">
        <h2>Confirmação e Salvamento</h2>
        <div className="detail-section" style={{textAlign: 'left'}}>
            <p><strong>Contrato/Cidade:</strong> {recordData.contractGroup}</p>
            <p><strong>Serviço:</strong> {recordData.serviceType}</p>
            {recordData.serviceOrderNumber && <p><strong>Ordem de Serviço:</strong> {recordData.serviceOrderNumber}</p>}
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
    onMeasurementUpdate: (recordId: number, newMeasurement: string) => Promise<void>;
    onViewImage: (src: string) => void; // Adicionado para Correção 1
}
const HistoryView: React.FC<HistoryViewProps> = ({ records, onSelect, isAdmin, onEdit, onDelete, selectedIds, onToggleSelect, onDeleteSelected, onMeasurementUpdate, onViewImage }) => {
    const [editingMeasurementId, setEditingMeasurementId] = useState<string | null>(null);
    const [newMeasurement, setNewMeasurement] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const ITEMS_PER_PAGE = 10;
    const [selectedContractGroup, setSelectedContractGroup] = useState('');
    
    // --- FILTROS DE DATA (CORREÇÃO ANTERIOR) ---
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    // ------------------------------------------

    const handleSaveMeasurement = async (recordId: string) => {
        await onMeasurementUpdate(parseInt(recordId), newMeasurement);
        setEditingMeasurementId(null);
    };

    const renderMeasurement = (record: ServiceRecord) => {
        const original = record.locationArea ? `${record.locationArea.toFixed(2)} ${record.serviceUnit}` : 'N/A';
        
        if (record.overrideMeasurement !== null && record.overrideMeasurement !== undefined) {
            return (
                <>
                    <strong style={{ color: 'var(--danger-color)' }}>{record.overrideMeasurement.toFixed(2)} {record.serviceUnit}</strong>
                    <em style={{ fontSize: '0.8em', display: 'block' }}>(Original: {original})</em>
                </>
            );
        }
        return original;
    };

    // Filter and Pagination Logic
    const filteredRecords = useMemo(() => {
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;
        if (end) end.setHours(23, 59, 59, 999); 
    
    // 1. NORMALIZA O TERMO DE BUSCA UMA VEZ
        const normalizedSearchTerm = normalizeString(searchTerm);

        return records.filter(record => {
            const recordDate = new Date(record.startTime);

    // 2. APLICA A NORMALIZAÇÃO NOS CAMPOS DE BUSCA (Busca Flexível)
            const textMatch = normalizeString(record.locationName).includes(normalizedSearchTerm) ||
                normalizeString(record.serviceType).includes(normalizedSearchTerm) ||
                normalizeString(record.operatorName).includes(normalizedSearchTerm) ||
                (record.serviceOrderNumber && normalizeString(record.serviceOrderNumber).includes(normalizedSearchTerm));
            
            if (!textMatch) return false;

            // 3. APLICA OS FILTROS DE DATA E CONTRATO
            if (start && recordDate < start) return false;
            if (end && recordDate > end) return false;
            if (selectedContractGroup && record.contractGroup !== selectedContractGroup) return false;

            return true;
        });
    }, [records, searchTerm, startDate, endDate, selectedContractGroup]); // Fim do useMemo

    const totalPages = Math.ceil(filteredRecords.length / ITEMS_PER_PAGE);
    const currentRecords = filteredRecords.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    // Reset page when search or date changes
    // useEffect(() => { setCurrentPage(1); }, [searchTerm, startDate, endDate]);

    return (
        <div>
            <SearchBar value={searchTerm} onChange={setSearchTerm} placeholder="Buscar por local, serviço, operador ou O.S..." />
            
            {/* --- Inputs de Data (CORREÇÃO ANTERIOR) --- */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                <div className="form-group">
                    <label>Data de Início</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div className="form-group">
                    <label>Data Final</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
            </div>

            {/* Adicionar Filtro de Contrato/Cidade (NOVO) */}
            <div className="form-group">
                <label>Contrato/Cidade</label>
                <select value={selectedContractGroup} onChange={e => setSelectedContractGroup(e.target.value)}>
                    <option value="">Todos os Contratos</option>
                    {[...new Set(records.map(r => r.contractGroup))].sort().map(group => (
                        <option key={group} value={group}>{group}</option>
                    ))}
                </select>
            </div>
         
            {/* ------------------------------------------ */}

            {isAdmin && selectedIds.size > 0 && (
                <div style={{ marginBottom: '1rem', textAlign: 'center' }}>
                    <button className="button button-danger" onClick={onDeleteSelected}>
                        Excluir {selectedIds.size} Iten(s) Selecionado(s)
                    </button>
                </div>
            )}
            {currentRecords.length === 0 ? <p style={{textAlign: 'center'}}>Nenhum registro encontrado.</p>
            : (
                <>
                    <ul className="history-list">
                        {currentRecords.map(record => (
                            <li key={record.id} className="list-item" style={{alignItems: 'center'}}>
                                {isAdmin && (
                                    <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, marginRight: '1rem' }}>
                                        <input type="checkbox" checked={selectedIds.has(record.id)} onChange={() => onToggleSelect(record.id)} style={{ width: '24px', height: '24px' }} />
                                    </div>
                                )}
                                <div onClick={() => onSelect(record)} style={{ flexGrow: 1, cursor: 'pointer'}}>
                                    <p><strong>Local:</strong> {record.locationName}, {record.contractGroup} {record.gpsUsed && <span className="gps-indicator">📍</span>}</p>
                                    <p><strong>Serviço:</strong> {record.serviceType}</p>
                                    {record.serviceOrderNumber && <p><strong>O.S.:</strong> {record.serviceOrderNumber}</p>}
                                    <p><strong>Data:</strong> {formatDateTime(record.startTime)}</p>
                                    {isAdmin && <p><strong>Operador:</strong> {record.operatorName}</p>}
                                    <p><strong>Medição: </strong> 
                                        {editingMeasurementId === record.id ? (
                                            <span onClick={e => e.stopPropagation()}>
                                                <input 
                                                    type="number" 
                                                    value={newMeasurement}
                                                    onChange={e => setNewMeasurement(e.target.value)}
                                                    autoFocus
                                                    onBlur={() => handleSaveMeasurement(record.id)}
                                                    style={{width: '80px', padding: '2px'}}
                                                />
                                                <button className="button button-sm" onClick={() => handleSaveMeasurement(record.id)}>Ok</button>
                                            </span>
                                        ) : (
                                            <span onDoubleClick={isAdmin ? () => { setEditingMeasurementId(record.id); setNewMeasurement(String(record.overrideMeasurement ?? record.locationArea ?? '')) } : undefined}>
                                                {renderMeasurement(record)}
                                            </span>
                                        )}
                                    </p>
                                    <div className="history-item-photos">
                                        {(record.beforePhotos || []).slice(0,2).map((p,i) => (
                                            <button 
                                                key={`b-${i}`} 
                                                onClick={(e) => { e.stopPropagation(); onViewImage(`${API_BASE}${p}`); }} 
                                                style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} // Correção 1: Torna a miniatura clicável
                                            >
                                                <img src={`${API_BASE}${p}`} alt="antes" />
                                            </button>
                                        ))}
                                        {(record.afterPhotos || []).slice(0,2).map((p,i) => (
                                            <button 
                                                key={`a-${i}`} 
                                                onClick={(e) => { e.stopPropagation(); onViewImage(`${API_BASE}${p}`); }} 
                                                style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} // Correção 1: Torna a miniatura clicável
                                            >
                                                <img src={`${API_BASE}${p}`} alt="depois" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="list-item-actions">
                                    {isAdmin && onEdit && ( <button className="button button-sm admin-button" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>Editar</button> )}
                                    {!isAdmin && onEdit && !record.endTime && ( <button className="button button-sm" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>Reabrir</button> )}
                                    {isAdmin && onDelete && ( <button className="button button-sm button-danger" onClick={(e) => { e.stopPropagation(); onDelete(record.id); }}>Excluir</button> )}
                                </div>
                            </li>
                        ))}
                    </ul>
                    <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
                </>
            )}
        </div>
    );
};

const DetailView: React.FC<{ record: ServiceRecord; onViewImage: (src: string) => void; }> = ({ record, onViewImage }) => ( // Adicionado onViewImage
    <div className="detail-view">
        <div className="detail-section card">
            <h3>Resumo</h3>
            <p><strong>Contrato/Cidade:</strong> {record.contractGroup}</p>
            <p><strong>Local:</strong> {record.locationName} {record.gpsUsed && <span className='gps-indicator'>📍(GPS)</span>}</p>
            <p><strong>Ordem de Serviço:</strong> {record.serviceOrderNumber || 'N/A'}</p>
            <p><strong>Observações:</strong> {record.observations || 'Nenhuma'}</p>
            <p><strong>Serviço:</strong> {record.serviceType}</p>
            {record.overrideMeasurement !== null && record.overrideMeasurement !== undefined 
                ? <p><strong>Metragem Válida:</strong> {record.overrideMeasurement.toFixed(2)} {record.serviceUnit} <em style={{fontSize: '0.8em'}}>(Original: {record.locationArea?.toFixed(2)})</em></p> 
                : <p><strong>Metragem:</strong> {record.locationArea ? `${record.locationArea.toFixed(2)} ${record.serviceUnit}` : 'Não informada'}</p>
            }
            <p><strong>Operador:</strong> {record.operatorName}</p>
            <p><strong>Início:</strong> {formatDateTime(record.startTime)}</p>
            <p><strong>Fim:</strong> {record.endTime ? formatDateTime(record.endTime) : 'Não finalizado'}</p>
        </div>
        <div className="detail-section card">
            <h3>Fotos "Antes" ({(record.beforePhotos || []).length})</h3>
            <div className="photo-gallery">
                {(record.beforePhotos || []).map((p,i) => (
                     <button 
                        key={`b-${i}`} 
                        onClick={() => onViewImage(`${API_BASE}${p}`)} 
                        style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                    >
                        <img src={`${API_BASE}${p}`} alt={`Antes ${i+1}`} />
                    </button>
                ))}
            </div>
        </div>
        <div className="detail-section card">
            <h3>Fotos "Depois" ({(record.afterPhotos || []).length})</h3>
            <div className="photo-gallery">
                {(record.afterPhotos || []).map((p,i) => (
                    <button 
                        key={`a-${i}`} 
                        onClick={() => onViewImage(`${API_BASE}${p}`)} 
                        style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                    >
                        <img src={`${API_BASE}${p}`} alt={`Depois ${i+1}`} />
                    </button>
                ))}
            </div>
        </div>
    </div>
);
const ReportsView: React.FC<{ records: ServiceRecord[]; services: ServiceDefinition[]; locations: LocationRecord[]; }> = ({ records, services, locations }) => {
    const [reportType, setReportType] = useState<'excel' | 'photos' | 'billing' | null>(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [selectedServices, setSelectedServices] = useState<string[]>([]);
    const [selectedContractGroup, setSelectedContractGroup] = useState('');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const printableRef = useRef<HTMLDivElement>(null);
    const [isGenerating, setIsGenerating] = useState(false);

    // --- CORREÇÃO 1: Mapeamento para busca rápida de Pais/Bairros ---
    const locationMap = useMemo(() => {
        return locations.reduce((acc, loc) => {
            acc[loc.id] = loc;
            return acc;
        }, {} as Record<string, LocationRecord>);
    }, [locations]);

    // --- CORREÇÃO 2: Função para resolver o nome completo (Bairro - Rua) ---
    const getFullLocationName = (record: ServiceRecord) => {
        // Se não tiver ID de local, retorna o nome gravado
        if (!record.locationId) return record.locationName;
        
        const loc = locationMap[record.locationId];
        
        // Se o local existe no cadastro e tem um Pai (parentId)
        if (loc && loc.parentId) {
            const parent = locationMap[loc.parentId];
            if (parent) {
                // Formato: "Nome do Bairro - Nome da Rua"
                return `${parent.name} - ${record.locationName}`;
            }
        }
        return record.locationName;
    };

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
        if(e.target.checked) setSelectedIds(filteredRecords.map(r => r.id));
        else setSelectedIds([]);
    };

    const handleSelectOne = (id: string, isChecked: boolean) => {
        if(isChecked) setSelectedIds(ids => [...ids, id]);
        else setSelectedIds(ids => ids.filter(i => i !== id));
    };

    const selectedRecords = records.filter(r => selectedIds.includes(r.id));
    const totalArea = selectedRecords.reduce((sum, r) => sum + (r.locationArea || 0), 0);

    const handleExportExcel = async () => {
        if (selectedRecords.length === 0) {
            alert("Nenhum registro selecionado para exportar.");
            return;
        }
        setIsGenerating(true);
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relatório de Serviços');
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 10 }, { header: 'Data Início', key: 'startTime', width: 20 },
            { header: 'Data Fim', key: 'endTime', width: 20 }, { header: 'Contrato/Cidade', key: 'contractGroup', width: 25 },
            { header: 'Local', key: 'locationName', width: 50 }, // Aumentei a largura
            { header: 'Serviço', key: 'serviceType', width: 30 },
            { header: 'Medição', key: 'locationArea', width: 15 }, { header: 'Unidade', key: 'serviceUnit', width: 15 },
            { header: 'Operador', key: 'operatorName', width: 25 }, { header: 'Usou GPS', key: 'gpsUsed', width: 10 },
            { header: 'O.S.', key: 'os', width: 15 },
        ];
        selectedRecords.forEach(record => {
            worksheet.addRow({
                id: record.id, startTime: formatDateTime(record.startTime),
                endTime: record.endTime ? formatDateTime(record.endTime) : 'Não finalizado',
                contractGroup: record.contractGroup, 
                locationName: getFullLocationName(record), // --- CORREÇÃO 3: Uso da função aqui ---
                serviceType: record.serviceType, locationArea: record.locationArea,
                serviceUnit: record.serviceUnit, operatorName: record.operatorName,
                gpsUsed: record.gpsUsed ? 'Sim' : 'Não',
                os: record.serviceOrderNumber || ''
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
        } finally {
            setIsGenerating(false);
        }
    };

    const handleExportBillingExcel = async () => {
        if (selectedRecords.length === 0) {
            alert("Nenhum registro selecionado para exportar.");
            return;
        }
        setIsGenerating(true);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Planilha de Faturamento');

        // --- STYLES ---
        const centerBoldStyle = { font: { bold: true }, alignment: { horizontal: 'center' as const, vertical: 'middle' as const } };
        const leftBoldStyle = { font: { bold: true }, alignment: { horizontal: 'left' as const, vertical: 'middle' as const } };
        const centerStyle = { alignment: { horizontal: 'center' as const, vertical: 'middle' as const } };
        const titleStyle = { font: { bold: true, size: 14 }, alignment: { horizontal: 'center' as const, vertical: 'middle' as const } };
        const yellowFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } } as ExcelJS.Fill;
        const thinBorder = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } } as ExcelJS.Borders;
        const numberFormat = '#,##0.00';

        // --- HEADER ---
        worksheet.mergeCells('A1:K1');
        worksheet.getCell('A1').value = 'C.R.B COMERCIO E SERVIÇOS DE MANUTENÇÃO EM GERAL LTDA';
        worksheet.getCell('A1').style = centerBoldStyle;
        worksheet.mergeCells('A2:K2');
        worksheet.getCell('A2').value = 'CNPJ: 10.397.876/0001-77';
        worksheet.getCell('A2').style = centerStyle;
        worksheet.mergeCells('A3:K3');
        worksheet.getCell('A3').value = 'PLANILHA DE FATURAMENTO';
        worksheet.getCell('A3').style = titleStyle;

        // Linha 5
        worksheet.mergeCells('A5:D5');
        worksheet.getCell('A5').value = 'CONTRATO ADMINISTRATIVO Nº:';
        worksheet.getCell('A5').style = leftBoldStyle;
        worksheet.mergeCells('E5:F5');
        worksheet.getCell('E5').value = 'NÚMERO MEDIÇÃO:';
        worksheet.getCell('E5').style = leftBoldStyle;
        worksheet.mergeCells('G5:H5');
        worksheet.getCell('G5').value = 'PERÍODO:';
        worksheet.getCell('G5').style = leftBoldStyle;
        worksheet.mergeCells('I5:K5');
        const formattedStartDate = startDate ? new Date(startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
        const formattedEndDate = endDate ? new Date(endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'N/A';
        worksheet.getCell('I5').value = `${formattedStartDate} até ${formattedEndDate}`;
        worksheet.getCell('I5').style = centerStyle;

        // --- DATA ---
        const groupedRecords = selectedRecords.reduce((acc, record) => {
            const key = `${record.serviceType} (${record.serviceUnit})`;
            (acc[key] = acc[key] || []).push(record);
            return acc;
        }, {} as Record<string, ServiceRecord[]>);

        let currentColumn = 1;
        let maxRows = 8;
        const serviceSummaryInfo: { serviceAndUnit: string, metragemColumn: string, firstRow: number, lastRow: number, serviceType: string }[] = [];
        const metragemColumnIndexOffset = 3; 

        Object.keys(groupedRecords).forEach(serviceAndUnit => {
            const records = groupedRecords[serviceAndUnit];
            if (records.length === 0) return;
            const serviceType = records[0].serviceType;

            worksheet.mergeCells(7, currentColumn, 7, currentColumn + metragemColumnIndexOffset);
            const headerCell = worksheet.getCell(7, currentColumn);
            headerCell.value = serviceType.toUpperCase();
            headerCell.style = { ...centerBoldStyle, fill: yellowFill, border: thinBorder };

            const subheaders = ['O.S.', 'DATA', 'LOCAL', `METRAGEM EM`];
            subheaders.forEach((text, i) => {
                const cell = worksheet.getCell(8, currentColumn + i);
                cell.value = text;
                cell.style = { ...centerBoldStyle, fill: yellowFill, border: thinBorder };
            });

            const metragemColumn = worksheet.getColumn(currentColumn + metragemColumnIndexOffset);
            metragemColumn.numFmt = numberFormat;

            let currentRow = 9;
            records.forEach(record => {
                worksheet.getCell(currentRow, currentColumn).value = record.serviceOrderNumber || '';
                worksheet.getCell(currentRow, currentColumn + 1).value = new Date(record.startTime).toLocaleDateString('pt-BR');
                // --- CORREÇÃO 4: Uso da função aqui também ---
                worksheet.getCell(currentRow, currentColumn + 2).value = getFullLocationName(record);
                worksheet.getCell(currentRow, currentColumn + 3).value = record.locationArea;
                for (let i = 0; i < 4; i++) {
                     worksheet.getCell(currentRow, currentColumn + i).border = thinBorder;
                }
                currentRow++;
            });

            if (currentRow > maxRows) maxRows = currentRow;
            serviceSummaryInfo.push({
                serviceAndUnit: serviceAndUnit,
                metragemColumn: metragemColumn.letter,
                firstRow: 9,
                lastRow: currentRow - 1,
                serviceType: serviceType
            });
            currentColumn += 5;
        });
        
        // --- QUADRO RESUMO ---
        let summaryStartCol = 1;
        if (currentColumn > 5) { summaryStartCol = currentColumn; } else { summaryStartCol = 10; }
        
        worksheet.mergeCells(7, summaryStartCol, 7, summaryStartCol + 2);
        const summaryHeader = worksheet.getCell(7, summaryStartCol);
        summaryHeader.value = 'QUADRO RESUMO';
        summaryHeader.style = { ...centerBoldStyle, fill: yellowFill, border: thinBorder };
        
        const summaryHeaders = ['SERVIÇOS', 'METRAGEM TOTAL', 'METRAGEM REALIZADA'];
        summaryHeaders.forEach((text, i) => {
            const cell = worksheet.getCell(8, summaryStartCol + i);
            cell.value = text;
            cell.style = { ...centerBoldStyle, fill: yellowFill, border: thinBorder };
            if (i === 1 || i === 2) {
                worksheet.getColumn(summaryStartCol + i).numFmt = numberFormat;
            }
        });

        let summaryCurrentRow = 9;
        serviceSummaryInfo.forEach(info => {
            worksheet.getCell(summaryCurrentRow, summaryStartCol).value = info.serviceAndUnit;
            worksheet.getCell(summaryCurrentRow, summaryStartCol + 1).value = ''; 
            const realizedCell = worksheet.getCell(summaryCurrentRow, summaryStartCol + 2);
            realizedCell.value = { formula: `SUM(${info.metragemColumn}${info.firstRow}:${info.metragemColumn}${info.lastRow})` };
            for (let i = 0; i < 3; i++) {
                worksheet.getCell(summaryCurrentRow, summaryStartCol + i).border = thinBorder;
            }
            summaryCurrentRow++;
        });

        worksheet.columns.forEach(column => {
            let maxLength = 0;
            column.eachCell!({ includeEmpty: true }, cell => {
                let columnLength = cell.value ? cell.value.toString().length : 10;
                if (columnLength > maxLength) maxLength = columnLength;
            });
            column.width = Math.max(10, maxLength + 2);
        });

        try {
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `relatorio_faturamento_crb_${new Date().toISOString().split('T')[0]}.xlsx`;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (error) {
            console.error("Erro ao gerar Excel de Faturamento:", error);
            alert("Ocorreu um erro ao gerar o arquivo Excel de faturamento.");
        } finally {
            setIsGenerating(false);
        }
    };


    const handleGeneratePdfClick = () => {
        if (selectedRecords.length === 0) {
            alert("Por favor, selecione ao menos um registro para gerar o PDF.");
            return;
        }
        setIsGenerating(true);
    };

    const PdfLayout = () => {
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

                // Paginação
                const PAGE_CAPACITY = 10;
                const HEADER_COST = 2.5;
                const ROW_COST = 2.0;
                const paginatedRecords: ServiceRecord[][] = [];
                let currentPage: ServiceRecord[] = [];
                let currentLoad = 0;

                selectedRecords.forEach(record => {
                    const maxPhotos = Math.max((record.beforePhotos || []).length, (record.afterPhotos || []).length);
                    const photoRows = Math.ceil(maxPhotos); 
                    const recordCost = HEADER_COST + (photoRows * ROW_COST);

                    if (recordCost > PAGE_CAPACITY) {
                        if (currentPage.length > 0) {
                            paginatedRecords.push(currentPage);
                            currentPage = [];
                            currentLoad = 0;
                        }
                        paginatedRecords.push([record]);
                    } 
                    else if (currentLoad + recordCost > PAGE_CAPACITY) {
                        paginatedRecords.push(currentPage);
                        currentPage = [record];
                        currentLoad = recordCost;
                    } 
                    else {
                        currentPage.push(record);
                        currentLoad += recordCost;
                    }
                });
                if (currentPage.length > 0) {
                    paginatedRecords.push(currentPage);
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
                        const pdfPageWidth = doc.internal.pageSize.getWidth();

                        for (let i = 0; i < pageElements.length; i++) {
                            const page = pageElements[i] as HTMLElement;
                            const canvas = await html2canvas(page, { scale: 2, useCORS: true, logging: false });
                            const imgData = canvas.toDataURL('image/jpeg', 0.85); 
                            if (i > 0) doc.addPage();
                            const imgProps = doc.getImageProperties(imgData);
                            const proportionalHeight = (imgProps.height * pdfPageWidth) / imgProps.width;
                            doc.addImage(imgData, 'JPEG', 0, 0, pdfPageWidth, proportionalHeight);
                        }
                        doc.save(`relatorio_fotos_crb_${new Date().toISOString().split('T')[0]}.pdf`);
                    } catch (error) {
                        console.error("Erro ao gerar PDF:", error);
                        alert("Ocorreu um erro ao gerar o PDF.");
                    } finally {
                        setIsGenerating(false);
                    }
                })();
            }
        }, [isLoadingImages, pages]);
        
        if (isLoadingImages) return null;
        
        const today = new Date().toLocaleDateString('pt-BR');
        const contractTitle = pages[0]?.[0]?.contractGroup || "";
        
        const styles = {
            page: {
                width: '210mm',
                minHeight: '297mm', 
                padding: '10mm',
                backgroundColor: 'white',
                boxSizing: 'border-box' as const,
                border: '1px solid #eee', 
                marginBottom: '20px'
            },
            header: { display: 'flex', alignItems: 'center', marginBottom: '10px', borderBottom: '2px solid #333', paddingBottom: '10px' },
            logo: { maxHeight: '55px', width: 'auto', marginRight: '15px' },
            headerText: { flexGrow: 1 },
            recordBlock: { marginBottom: '15px', pageBreakInside: 'avoid' as const, border: '1px solid #ccc', padding: '10px', borderRadius: '4px' },
            infoTable: { width: '100%', marginBottom: '10px', borderCollapse: 'collapse' as const },
            infoCell: { padding: '4px', borderBottom: '1px solid #eee', fontSize: '10pt', verticalAlign: 'top' as const },
            photoTable: { width: '100%', borderCollapse: 'collapse' as const },
            photoCell: { width: '50%', padding: '5px', textAlign: 'center' as const, verticalAlign: 'top' as const, border: '1px solid #ddd' },
            img: { width: '100%', maxHeight: '180px', objectFit: 'contain' as const, display: 'block', margin: '0 auto' },
            caption: { fontSize: '8pt', marginTop: '4px', color: '#555' }
        };

        return (
            <div className="printable-report-container" ref={printableRef} style={{ position: 'absolute', top: '-10000px' }}>
                {pages.map((pageRecords, pageIndex) => (
                    <div key={pageIndex} className="printable-page" style={styles.page}>
                        <header style={styles.header}>
                            <img src={logoSrc} alt="Logo" style={styles.logo} />
                            <div style={styles.headerText}>
                                <h2 style={{margin: 0, fontSize: '14pt'}}>Relatório Fotográfico - {contractTitle}</h2>
                                <p style={{margin: 0, fontSize: '10pt'}}>CRB Serviços Gerais</p>
                            </div>
                            <div style={{textAlign: 'right', fontSize: '9pt'}}>
                                <p>Emissão: {today}</p>
                                <p>Pág. {pageIndex + 1}/{pages.length}</p>
                            </div>
                        </header>
                        
                        <div className="pdf-page-content">
                            {pageRecords.map(record => {
                                const maxPhotos = Math.max((record.beforePhotos || []).length, (record.afterPhotos || []).length);
                                const photoPairs = [];
                                for (let i = 0; i < maxPhotos; i++) {
                                    photoPairs.push({ before: record.beforePhotos?.[i], after: record.afterPhotos?.[i] });
                                }
                                // --- CORREÇÃO 5: Uso da função para pegar nome composto ---
                                const locationDisplayName = getFullLocationName(record);
                                
                                return (
                                    <div key={record.id} style={styles.recordBlock}>
                                        <table style={styles.infoTable}>
                                            <tbody>
                                                <tr>
                                                    {/* Exibe Bairro - Rua no cabeçalho do item */}
                                                    <td style={styles.infoCell} colSpan={4}><strong>Local:</strong> {locationDisplayName}</td>
                                                </tr>
                                                <tr>
                                                    <td style={{...styles.infoCell, width: '20%'}}><strong>Data:</strong> {new Date(record.startTime).toLocaleDateString('pt-BR')}</td>
                                                    <td style={{...styles.infoCell, width: '20%'}}><strong>O.S.:</strong> {record.serviceOrderNumber || 'N/A'}</td>
                                                    <td style={{...styles.infoCell, width: '30%'}}><strong>Serviço:</strong> {record.serviceType}</td>
                                                    <td style={{...styles.infoCell, width: '30%'}}>
                                                        <strong>Medição:</strong> {record.locationArea ? `${record.locationArea.toLocaleString('pt-BR')} ${record.serviceUnit}` : 'N/A'}
                                                    </td>
                                                </tr>
                                            </tbody>
                                        </table>

                                        <table style={styles.photoTable}>
                                            <thead>
                                                <tr style={{backgroundColor: '#f8f9fa'}}>
                                                    <th style={{...styles.photoCell, fontSize: '10pt'}}>ANTES</th>
                                                    <th style={{...styles.photoCell, fontSize: '10pt'}}>DEPOIS</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {photoPairs.map((pair, index) => (
                                                    <tr key={index}>
                                                        <td style={styles.photoCell}>
                                                            {pair.before ? (
                                                                <>
                                                                    <img src={loadedImages[`${API_BASE}${pair.before}`]} alt="Antes" style={styles.img} />
                                                                    {/* Legenda com o nome composto também */}
                                                                    <div style={styles.caption}>{locationDisplayName}</div>
                                                                </>
                                                            ) : <div style={{height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc'}}>Sem foto</div>}
                                                        </td>
                                                        <td style={styles.photoCell}>
                                                            {pair.after ? (
                                                                <>
                                                                    <img src={loadedImages[`${API_BASE}${pair.after}`]} alt="Depois" style={styles.img} />
                                                                    <div style={styles.caption}>{locationDisplayName}</div>
                                                                </>
                                                            ) : <div style={{height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ccc'}}>Sem foto</div>}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    if (isGenerating) {
        return (
            <>
                <Loader text="Gerando relatório PDF, por favor aguarde... Isso pode levar alguns minutos." />
                {reportType === 'photos' && <PdfLayout />}
            </>
        );
    }

    if (!reportType) {
        return (
            <div className="card">
                <h2>Selecione o Tipo de Relatório</h2>
                <div className="button-group" style={{flexDirection: 'column', gap: '1rem'}}>
                    <button className="button" onClick={() => setReportType('excel')}>📊 Relatório Planilha (Simples)</button>
                    <button className="button" onClick={() => setReportType('billing')}>📋 RELATÓRIO FINAL (Faturamento)</button>
                    <button className="button button-secondary" onClick={() => setReportType('photos')}>🖼️ Relatório de Fotografias (PDF)</button>
                </div>
            </div>
        );
    }

    return (
         <div className="card">
            <button className="button button-sm button-secondary" onClick={() => setReportType(null)} style={{float: 'right'}}>Trocar Tipo</button>
            <h2>Filtros para {reportType === 'excel' ? 'Relatório Simples' : reportType === 'billing' ? 'Relatório Final' : 'Relatório de Fotos'}</h2>
            <div className="report-filters" style={{flexDirection: 'column', alignItems: 'stretch', clear: 'both'}}>
                <div style={{display: 'flex', gap: '1rem', flexWrap: 'wrap'}}>
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
                    {reportType === 'billing' && <button className="button" onClick={handleExportBillingExcel} disabled={selectedIds.length === 0}>Gerar Relatório Final</button>}
                    {reportType === 'photos' && <button className="button" onClick={handleGeneratePdfClick} disabled={selectedIds.length === 0}>Gerar PDF com Fotos</button>}
                </div>
            </div>
            <ul className="report-list" style={{marginTop: '1rem'}}>
                {filteredRecords.length > 0 && <li><label><input type="checkbox" onChange={handleSelectAll} checked={selectedIds.length === filteredRecords.length && filteredRecords.length > 0} /> Selecionar Todos</label></li>}
                {filteredRecords.map(record => (
                    <li key={record.id} className="report-item">
                        <input type="checkbox" checked={selectedIds.includes(record.id)} onChange={e => handleSelectOne(record.id, e.target.checked)} />
                        <div className="report-item-info">
                            {/* Uso da função aqui também para visualização na lista */}
                            <p><strong>{getFullLocationName(record)}</strong> - {record.serviceType}</p>
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
    addAuditLogEntry: (action: 'UPDATE' | 'DELETE', details: string, recordId?: string) => void;
}> = ({ locations, services, fetchData, addAuditLogEntry }) => {
    const [selectedGroup, setSelectedGroup] = useState('');
    const [name, setName] = useState('');
    const [observations, setObservations] = useState('');
    const [coords, setCoords] = useState<Partial<GeolocationCoords> | null>(null);
    const [isFetchingCoords, setIsFetchingCoords] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [serviceMeasurements, setServiceMeasurements] = useState<Record<string, string>>({});
    const [isGroupActionLoading, setIsGroupActionLoading] = useState(false);
    const [locationType, setLocationType] = useState<'SIMPLE' | 'NEIGHBORHOOD' | 'STREET'>('SIMPLE');
    const [parentId, setParentId] = useState<string | null>(null);
    
    // Search and Pagination State
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const ITEMS_PER_PAGE = 10;

    const allGroups = [...new Set(locations.map(l => l.contractGroup))].filter(Boolean).sort();
    
    const resetForm = () => {
        setName('');
        setObservations('');
        setCoords(null);
        setServiceMeasurements({});
        setEditingId(null);
        setLocationType('SIMPLE');
        setParentId(null);
    };

    const handleAddNewGroup = () => {
        const newGroup = prompt('Digite o nome do novo Contrato/Cidade:');
        if (newGroup && newGroup.trim()) {
            setSelectedGroup(newGroup.trim().toUpperCase()); // Caixa alta
            resetForm();
            setSearchTerm(''); // Clear search to show the new group context
        }
    };

    const handleEditGroup = async () => {
        if (!selectedGroup) return;
        const newGroupName = prompt(`Digite o novo nome para o contrato/cidade "${selectedGroup}":`, selectedGroup);
        if (!newGroupName || newGroupName.trim() === '' || newGroupName.trim() === selectedGroup) return;

        const formattedNewName = newGroupName.trim().toUpperCase(); // Caixa alta
        
        if (window.confirm(`Tem certeza que deseja renomear "${selectedGroup}" para "${formattedNewName}"? Isso afetará todos os locais associados.`)) {
            setIsGroupActionLoading(true);
            try {
                await apiFetch(`/api/contract-groups/${encodeURIComponent(selectedGroup)}`, { method: 'PUT', body: JSON.stringify({ newName: formattedNewName }) });
                addAuditLogEntry('UPDATE', `Contrato/Cidade '${selectedGroup}' renomeado para '${formattedNewName}'`);
                alert('Contrato/Cidade renomeado com sucesso!');
                await fetchData(); 
                setSelectedGroup(formattedNewName);
            } catch (error) {
                alert('Falha ao renomear o Contrato/Cidade.');
                console.error(error);
            } finally { setIsGroupActionLoading(false); }
        }
    };

    const handleDeleteGroup = async () => {
        if (!selectedGroup) return;
        const associatedLocationsCount = locations.filter(l => l.contractGroup === selectedGroup).length;
        if (!window.confirm(`ATENÇÃO: Esta ação é irreversível.\n\nVocê está prestes a excluir o Contrato/Cidade "${selectedGroup}" e todos os seus ${associatedLocationsCount} locais associados.\n\nDeseja continuar?`)) return;
        const password = prompt('Para confirmar a exclusão, por favor, digite sua senha:');
        if (!password) { alert('A senha é necessária para confirmar a exclusão.'); return; }

        setIsGroupActionLoading(true);
        try {
            await apiFetch(`/api/contract-groups/${encodeURIComponent(selectedGroup)}`, { method: 'DELETE', body: JSON.stringify({ password: password }) });
            addAuditLogEntry('DELETE', `Contrato/Cidade '${selectedGroup}' e todos os seus locais associados foram excluídos.`);
            alert('Contrato/Cidade e todos os locais associados foram excluídos com sucesso!');
            await fetchData();
            resetForm();
            setSelectedGroup('');
        } catch (error) {
            alert('Falha ao excluir. Verifique sua senha.');
            console.error(error);
        } finally { setIsGroupActionLoading(false); }
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
        if (isChecked) { newMeasurements[serviceId] = ''; } else { delete newMeasurements[serviceId]; }
        setServiceMeasurements(newMeasurements);
    };

    const handleSave = async () => {
        if (!selectedGroup || !name) { alert('Contrato/Cidade e Nome do Local são obrigatórios.'); return; }
        
        const nameUpperCase = name.toUpperCase(); // Caixa alta

        const servicesPayload = locationType === 'STREET' ? [] : Object.entries(serviceMeasurements)
            .map(([service_id, measurementStr]) => {
                const measurement = parseFloat(measurementStr);
                const service = services.find(s => s.id === service_id);
                if (!service || isNaN(measurement)) return null;
                return { service_id, measurement };
            }).filter(Boolean);

        if (locationType !== 'STREET' && servicesPayload.length === 0 && !window.confirm("Nenhum serviço com medição válida foi adicionado. Deseja salvar este local mesmo assim?")) return;
        
        const payload: any = {
            city: selectedGroup.trim(),
            name: nameUpperCase,
            observations: observations.toUpperCase(), // Caixa alta
            lat: coords?.latitude,
            lng: coords?.longitude,
            services: servicesPayload,
            isGroup: locationType === 'NEIGHBORHOOD',
            parentId: locationType === 'STREET' ? parentId : null
        };

        try {
            if (editingId) { await apiFetch(`/api/locations/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) }); }
            else { await apiFetch('/api/locations', { method: 'POST', body: JSON.stringify(payload) }); }
            alert(`Local "${nameUpperCase}" salvo com sucesso!`);
            resetForm();
            await fetchData();
        } catch (error) { alert('Falha ao salvar local.'); console.error(error); }
    };

    const handleEdit = (loc: LocationRecord) => {
        setEditingId(loc.id);
        setName(loc.name);
        setObservations(loc.observations || '');
        setCoords(loc.coords || null);
        setSelectedGroup(loc.contractGroup);
        setSearchTerm(''); // Clear search to allow editing form to appear in context
        
        if (loc.parentId) {
            setLocationType('STREET');
            setParentId(loc.parentId);
        } else {
            setLocationType(loc.isGroup ? 'NEIGHBORHOOD' : 'SIMPLE');
            setParentId(null);
        }
        const initialMeasurements = (loc.services || []).reduce((acc, srv) => {
            acc[srv.serviceId] = String(srv.measurement);
            return acc;
        }, {} as Record<string, string>);
        setServiceMeasurements(initialMeasurements);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleDelete = async (id: string) => {
        if (window.confirm('Excluir este local?')) {
            try {
                await apiFetch(`/api/locations/${id}`, { method: 'DELETE' });
                await fetchData();
            } catch (error) { alert('Falha ao excluir local.'); console.error(error); }
        }
    };

    // Determine what to display
    const displayedLocations = useMemo(() => {
    // 1. NORMALIZA O TERMO DE BUSCA UMA VEZ
    const normalizedSearchTerm = normalizeString(searchTerm);
        if (searchTerm) {
            // Global Search
            return locations.filter(l => 
            // APLICA A NORMALIZAÇÃO NOS CAMPOS DE BUSCA
                normalizeString(l.name).includes(normalizedSearchTerm) ||
                normalizeString(l.contractGroup).includes(normalizedSearchTerm)
            );
        } else if (selectedGroup) {
            // Filter by group, showing top level only
            return locations.filter(l => l.contractGroup === selectedGroup && !l.parentId);
        }
        return [];
    }, [searchTerm, selectedGroup, locations]);

    const totalPages = Math.ceil(displayedLocations.length / ITEMS_PER_PAGE);
    const currentLocations = displayedLocations.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => { setCurrentPage(1); }, [searchTerm, selectedGroup]);

    const childrenMap = useMemo(() => {
        return locations.reduce((acc, loc) => {
            if (loc.parentId) {
                if (!acc[loc.parentId]) acc[loc.parentId] = [];
                acc[loc.parentId].push(loc);
            }
            return acc;
        }, {} as Record<string, LocationRecord[]>);
    }, [locations]);

    return (
        <div>
            <div className="card">
                <h3>Gerenciar Contrato/Cidade</h3>
                
                <SearchBar value={searchTerm} onChange={setSearchTerm} placeholder="Pesquisar endereço em todos os contratos..." />
                
                {!searchTerm && (
                    <div className="form-group contract-group-selector">
                        <select value={selectedGroup} onChange={e => { setSelectedGroup(e.target.value); resetForm(); }}>
                            <option value="">Selecione um Contrato/Cidade</option>
                            {allGroups.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                         <div className="contract-group-actions">
                            <button className="button button-sm admin-button" onClick={handleEditGroup} disabled={!selectedGroup || isGroupActionLoading}>Editar Nome</button>
                            <button className="button button-sm button-danger" onClick={handleDeleteGroup} disabled={!selectedGroup || isGroupActionLoading}>Excluir Contrato</button>
                        </div>
                        <button className="button button-secondary" onClick={handleAddNewGroup}>Adicionar Novo</button>
                    </div>
                )}
            </div>

            {searchTerm ? (
                 <div className="card">
                    <h4>Resultados da Busca ({displayedLocations.length})</h4>
                    <ul className="location-list">
                        {currentLocations.map(loc => (
                            <li key={loc.id} className="card list-item">
                                <div className="list-item-info">
                                    <div className="list-item-header">
                                        <h3>{loc.name} <small style={{fontWeight:'normal', fontSize:'0.8rem'}}>({loc.contractGroup})</small></h3>
                                        <div>
                                            <button className="button button-sm admin-button" onClick={() => handleEdit(loc)}>Editar</button>
                                            <button className="button button-sm button-danger" onClick={() => handleDelete(loc.id)}>Excluir</button>
                                        </div>
                                    </div>
                                    <p>{loc.isGroup ? 'Tipo: Bairro' : loc.parentId ? 'Tipo: Rua' : 'Tipo: Local'}</p>
                                </div>
                            </li>
                        ))}
                    </ul>
                    <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
                </div>
            ) : (selectedGroup && (
                <>
                    <div className="form-container card">
                        <h3>{editingId ? 'Editando Local' : 'Adicionar Novo Local'} em "{selectedGroup}"</h3>
                        <fieldset className="form-group-full">
                            <legend>Tipo de Local</legend>
                             <div style={{display: 'flex', justifyContent: 'space-around', gap: '1rem'}}>
                                <label><input type="radio" name="locType" value="SIMPLE" checked={locationType === 'SIMPLE'} onChange={() => setLocationType('SIMPLE')} /> Endereço Único</label>
                                <label><input type="radio" name="locType" value="NEIGHBORHOOD" checked={locationType === 'NEIGHBORHOOD'} onChange={() => setLocationType('NEIGHBORHOOD')} /> Bairro (Agrupador)</label>
                                <label><input type="radio" name="locType" value="STREET" checked={locationType === 'STREET'} onChange={() => setLocationType('STREET')} /> Rua (Dentro de Bairro)</label>
                            </div>
                        </fieldset>

                        {locationType === 'STREET' && (
                            <select value={parentId || ''} onChange={e => setParentId(e.target.value)}>
                                <option value="">Selecione o Bairro</option>
                                {locations.filter(l => l.contractGroup === selectedGroup && l.isGroup).map(loc => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                            </select>
                        )}
                        <input 
                            type="text" 
                            placeholder={locationType === 'STREET' ? 'Nome da Rua' : locationType === 'NEIGHBORHOOD' ? 'Nome do Bairro' : 'Nome do Local/Endereço'} 
                            value={name} 
                            onChange={e => setName(e.target.value.toUpperCase())} // Caixa alta
                            onBlur={e => setName(e.target.value.toUpperCase())} // Caixa alta
                        />
                        
                        <textarea 
                            placeholder="Observações (opcional)" 
                            value={observations} 
                            onChange={e => setObservations(e.target.value.toUpperCase())} // Caixa alta
                            onBlur={e => setObservations(e.target.value.toUpperCase())} // Caixa alta
                            rows={3}
                        ></textarea>
                        
                        {locationType !== 'STREET' && (
                            <fieldset className="service-assignment-fieldset"><legend>Serviços e Medições do Local</legend><div className="checkbox-group">
                                {services.sort((a,b) => a.name.localeCompare(b.name)).map(service => {
                                    const isChecked = service.id in serviceMeasurements;
                                    return (<div key={service.id} className="checkbox-item" style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem', border: '1px solid #eee', padding: '0.5rem', borderRadius: '4px'}}>
                                        <div><input type="checkbox" id={`service-loc-${service.id}`} checked={isChecked} onChange={e => handleServiceToggle(service.id, e.target.checked)} /><label htmlFor={`service-loc-${service.id}`}>{service.name}</label></div>
                                        {isChecked && (<input type="number" placeholder={`Medição (${service.unit.symbol})`} value={serviceMeasurements[service.id] || ''} onChange={e => handleMeasurementChange(service.id, e.target.value)} style={{width: '100%'}} />)}
                                    </div>);
                                })}
                            </div></fieldset>
                        )}

                        <fieldset className="form-group-full"><legend>Coordenadas GPS (Opcional)</legend>
                            <div className="coord-inputs"><input type="number" placeholder="Latitude" value={coords?.latitude || ''} onChange={e => handleCoordChange('latitude', e.target.value)} /><input type="number" placeholder="Longitude" value={coords?.longitude || ''} onChange={e => handleCoordChange('longitude', e.target.value)} /></div>
                            <button className="button button-secondary" onClick={handleGetCoordinates} disabled={isFetchingCoords} style={{ marginTop: '0.5rem' }}>{isFetchingCoords ? 'Obtendo...' : '📍 Obter GPS Atual'}</button>
                        </fieldset>
                        
                        <button className="button admin-button" onClick={handleSave}>{editingId ? 'Salvar Alterações' : 'Adicionar Local'}</button>
                        {editingId && <button className="button button-secondary" onClick={resetForm}>Cancelar Edição</button>}
                    </div>
                    
                     <ul className="location-list">
                        {currentLocations.sort((a,b) => a.name.localeCompare(b.name)).map(loc => (
                           <React.Fragment key={loc.id}>
                                <li className="card list-item">
                                    <div className="list-item-info">
                                         <div className="list-item-header">
                                            <h3>{loc.name} {loc.isGroup ? '(Bairro)' : ''}</h3>
                                            <div>
                                                <button className="button button-sm admin-button" onClick={() => handleEdit(loc)}>Editar</button>
                                                <button className="button button-sm button-danger" onClick={() => handleDelete(loc.id)}>Excluir</button>
                                            </div>
                                        </div>
                                        <p><em>{loc.observations}</em></p>
                                         <div className="location-services-list"><strong>Serviços:</strong>{(loc.services && loc.services.length > 0) ? (<ul>{loc.services.map(s => <li key={s.serviceId}>{s.name}: {s.measurement} {s.unit.symbol}</li>)}</ul>) : ' Nenhum atribuído'}</div>
                                    </div>
                                </li>
                                {(childrenMap[loc.id] || []).sort((a,b) => a.name.localeCompare(b.name)).map(child => (
                                    <li key={child.id} className="card list-item" style={{ marginLeft: '2rem', borderLeft: '3px solid var(--primary-color)' }}>
                                        <div className="list-item-info">
                                             <div className="list-item-header">
                                                <h3>{child.name} (Rua)</h3>
                                                <div>
                                                    <button className="button button-sm admin-button" onClick={() => handleEdit(child)}>Editar</button>
                                                    <button className="button button-sm button-danger" onClick={() => handleDelete(child.id)}>Excluir</button>
                                                </div>
                                            </div>
                                            <p><em>{child.observations}</em></p>
                                            <div className="location-services-list"><strong>Serviços:</strong>{(child.services && child.services.length > 0) ? (<ul>{child.services.map(s => <li key={s.serviceId}>{s.name}: {s.measurement} {s.unit.symbol}</li>)}</ul>) : ' Nenhum atribuído'}</div>
                                        </div>
                                    </li>
                                ))}
                           </React.Fragment>
                        ))}
                    </ul>
                    <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
                </>
            ))}
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
    const [editingId, setEditingId] = useState<string|null>(null);
    const [isLoading, setIsLoading] = useState(false);
    
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
        ].sort((a,b) => a.contractGroup.localeCompare(b.contractGroup)));
        
        setNewAssignmentGroup('');
        setNewAssignmentServices(new Set());
    };
    
    const handleRemoveAssignment = (groupToRemove: string) => {
        setAssignments(prev => prev.filter(a => a.contractGroup !== groupToRemove));
    };

    const handleServiceCheckbox = (serviceName: string, checked: boolean) => {
        setNewAssignmentServices(prev => {
            const newSet = new Set(prev);
            if(checked) {
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
            await onUsersUpdate();
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
        setPassword('');
        setRole(user.role);
        setAssignments(user.assignments || []);
    };

    const handleDelete = async (id: string) => {
        if(window.confirm('Excluir este usuário? Esta ação não pode ser desfeita.')) {
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
}

const GoalsAndChartsView: React.FC<{
    records: ServiceRecord[];
    locations: LocationRecord[];
    services: ServiceDefinition[];
    contractConfigs: ContractConfig[];
    locationServiceMap: LocationRecordServiceMap; // Adicionado para Correção 3
}> = ({ records, locations, services, contractConfigs, locationServiceMap }) => {
    const [chartData, setChartData] = useState<any>(null);
    const [isLoadingChart, setIsLoadingChart] = useState(false);
    const [chartType, setChartType] = useState<'bar' | 'line'>('bar');
    const allContractGroups = [...new Set(locations.map(l => l.contractGroup).concat(records.map(r => r.contractGroup)))].filter(Boolean).sort();
    
    const [selectedContracts, setSelectedContracts] = useState<string[]>(allContractGroups);
    const defaultEndDate = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setMonth(defaultStartDate.getMonth() - 11);
    const [startDate, setStartDate] = useState(defaultStartDate.toISOString().slice(0, 10));
    const [endDate, setEndDate] = useState(defaultEndDate.toISOString().slice(0, 10));

    const [goals, setGoals] = useState<Goal[]>([]);
    const [contractGroupGoal, setContractGroupGoal] = useState('');
    const [monthGoal, setMonthGoal] = useState(new Date().toISOString().substring(0, 7));
    const [targetAreaGoal, setTargetAreaGoal] = useState('');
    const [serviceIdGoal, setServiceIdGoal] = useState('');
    const [editingIdGoal, setEditingIdGoal] = useState<string | null>(null);

    useEffect(() => {
        const fetchGoals = async () => {
            try {
                const fetchedGoals = await apiFetch('/api/goals');
                setGoals(fetchedGoals.map((g: any) => ({ ...g, id: String(g.id) })));
            } catch (error) {
                console.error("Failed to fetch goals", error);
                alert("Não foi possível carregar as metas.");
            }
        };
        fetchGoals();
    }, []);

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

    const resetFormGoal = () => {
        setContractGroupGoal('');
        setMonthGoal(new Date().toISOString().substring(0, 7));
        setTargetAreaGoal('');
        setServiceIdGoal('');
        setEditingIdGoal(null);
    };

    const handleSaveGoal = async () => {
        if (!contractGroupGoal || !monthGoal || !targetAreaGoal || isNaN(parseFloat(targetAreaGoal)) || !serviceIdGoal) {
            alert('Preencha todos os campos da meta corretamente, incluindo o serviço.');
            return;
        }
        const payload = {
            contractGroup: contractGroupGoal.toUpperCase(), // Caixa alta
            month: monthGoal,
            targetArea: parseFloat(targetAreaGoal),
            serviceId: parseInt(serviceIdGoal, 10),
        };

        try {
            if (editingIdGoal) {
                const updatedGoal = await apiFetch(`/api/goals/${editingIdGoal}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
                setGoals(prevGoals => prevGoals.map(g => g.id === editingIdGoal ? { ...updatedGoal, id: String(updatedGoal.id) } : g));
            } else {
                const newGoal = await apiFetch('/api/goals', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                setGoals(prevGoals => [{ ...newGoal, id: String(newGoal.id) }, ...prevGoals]);
            }
            resetFormGoal();
        } catch (error) {
            console.error("Error saving goal:", error);
            alert("Erro ao salvar a meta.");
        }
    };

    const handleEditGoal = (goal: Goal) => {
        setEditingIdGoal(goal.id);
        setContractGroupGoal(goal.contractGroup);
        setMonthGoal(goal.month);
        setTargetAreaGoal(String(goal.targetArea));
        setServiceIdGoal(String(goal.serviceId));
    };

    const handleDeleteGoal = async (id: string) => {
        if (window.confirm('Excluir esta meta?')) {
            try {
                await apiFetch(`/api/goals/${id}`, { method: 'DELETE' });
                setGoals(prevGoals => prevGoals.filter(g => g.id !== id));
            } catch (error) {
                console.error("Error deleting goal:", error);
                alert("Erro ao excluir a meta.");
            }
        }
    };
    
    // --- Funções para calcular o ciclo de medição da Meta (CORREÇÃO ANTERIOR) ---

    // Calcula a data de início do ciclo de medição para o MÊS da meta (YYYY-MM)
    const getCycleStartDateForGoal = (contractGroup: string, goalMonth: string): Date => {
        const config = contractConfigs.find(c => c.contractGroup === contractGroup);
        const cycleStartDay = config ? config.cycleStartDay : 1;
        
        const dateParts = goalMonth.split('-');
        const year = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1; // Mês é 0-indexado

        // Referência para o dia do mês
        let referenceDate = new Date(year, month, 1);
        if (referenceDate.getDate() < cycleStartDay) {
            // Se o dia do ciclo for maior que o dia 1, o ciclo daquele mês
            // começa no mês anterior. Ex: Meta de Jan/2026, Ciclo começa dia 10.
            // O ciclo que termina em Jan/2026 (dia 9) começou em Dez/2025 (dia 10).
             referenceDate = new Date(year, month, cycleStartDay);
        } else {
             referenceDate = new Date(year, month, cycleStartDay);
        }
        
        let cycleStartDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), cycleStartDay);
        
        // Ajuste: Se o dia da meta (qualquer dia do mês YYYY-MM) for menor que o dia de início
        // do ciclo, o ciclo relevante é o anterior. Ex: Hoje é dia 5. O ciclo começa dia 10.
        // O ciclo que termina no dia 9 deste mês é o do mês passado.
        if (cycleStartDate.getMonth() > month) { // Ex: cycleStartDate é Jan, month é Dez (mês anterior)
            cycleStartDate.setMonth(cycleStartDate.getMonth() - 1);
        }

        cycleStartDate.setHours(0, 0, 0, 0);
        return cycleStartDate;
    };
    
    // Calcula a data de fim do ciclo de medição para o MÊS da meta (YYYY-MM)
    const getCycleEndDateForGoal = (contractGroup: string, goalMonth: string): Date => {
        const cycleStart = getCycleStartDateForGoal(contractGroup, goalMonth);
        // O final do ciclo é o dia anterior ao início do PRÓXIMO ciclo.
        const nextCycleStart = new Date(cycleStart.getFullYear(), cycleStart.getMonth() + 1, cycleStart.getDate());
        
        const cycleEndDate = new Date(nextCycleStart.getTime() - 1000); // 1 segundo antes para pegar 23:59:59
        return cycleEndDate;
    }
    
    // ---------------------------------------------------------------------
    
    // Lógica para obter a medição MESTRE do bairro/local (Correção 3)
    const getMasterMeasurement = (record: ServiceRecord) => {
        if (!record.locationId || !record.serviceId) {
            return record.overrideMeasurement ?? record.locationArea ?? 0;
        }

        const location = locations.find(l => l.id === record.locationId);
        let masterLocationId = record.locationId;
        
        // Se for uma rua, busca o ID do pai (bairro) para pegar a medição dele
        if (location && location.parentId) {
            masterLocationId = location.parentId;
        }

        const masterMeasurement = locationServiceMap[masterLocationId]?.[String(record.serviceId)];
        
        // Se a medição mestre for encontrada, a usa. Senão, usa a medição do registro (que pode ser a ajustada ou a original)
        return masterMeasurement ?? (record.overrideMeasurement ?? record.locationArea ?? 0);
    };

    return (
        <div>
            <div className="card">
                <h3>Análise Gráfica de Desempenho</h3>
                <div className="report-filters" style={{flexDirection: 'column', alignItems: 'stretch'}}>
                    <div style={{display: 'flex', gap: '1rem', flexWrap: 'wrap'}}>
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
                        <div className="button-group" style={{justifyContent: 'flex-start', marginBottom: '1rem'}}>
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
                        <div style={{display: 'flex', gap: '1rem', justifyContent: 'center'}}>
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
                    <div style={{marginTop: '2rem'}}>
                        {chartType === 'bar' ? <Bar options={chartOptions} data={chartData} /> : <Line options={chartOptions} data={chartData} />}
                    </div>
                )}
            </div>
            
            <div className="form-container card">
                <h3>{editingIdGoal ? 'Editando Meta' : 'Adicionar Nova Meta'}</h3>
                <select value={serviceIdGoal} onChange={e => setServiceIdGoal(e.target.value)}>
                    <option value="">Selecione um Serviço</option>
                    {services.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                </select>
                <input 
                    list="goal-contract-groups" 
                    placeholder="Digite ou selecione um Contrato/Cidade" 
                    value={contractGroupGoal} 
                    onChange={e => setContractGroupGoal(e.target.value.toUpperCase())} 
                    onBlur={e => setContractGroupGoal(e.target.value.toUpperCase())}
                />
                <datalist id="goal-contract-groups">
                    {allContractGroups.map(g => <option key={g} value={g} />)}
                </datalist>
                <input type="month" value={monthGoal} onChange={e => setMonthGoal(e.target.value)} />
                <input type="number" placeholder="Meta de Medição" value={targetAreaGoal} onChange={e => setTargetAreaGoal(e.target.value)} />
                <button className="button admin-button" onClick={handleSaveGoal}>{editingIdGoal ? 'Salvar Alterações' : 'Adicionar Meta'}</button>
                {editingIdGoal && <button className="button button-secondary" onClick={resetFormGoal}>Cancelar Edição</button>}
            </div>

            <ul className="goal-list">
                {[...goals].sort((a, b) => b.month.localeCompare(a.month) || a.contractGroup.localeCompare(b.contractGroup)).map(goal => {
                    const service = services.find(s => s.id === String(goal.serviceId));
                    
                    // --- Cálculo da Área Realizada com base no Ciclo de Medição (Correção 3) ---
                    const cycleStartDate = getCycleStartDateForGoal(goal.contractGroup, goal.month);
                    const cycleEndDate = getCycleEndDateForGoal(goal.contractGroup, goal.month);
                    
                    // Mapeia registros ÚNICOS (locais mestres)
                    const uniqueRecordsInCycle = records
                        .filter(r => {
                            const recordDate = new Date(r.startTime);
                            return (
                                r.contractGroup === goal.contractGroup && 
                                r.serviceType === service?.name &&
                                recordDate >= cycleStartDate &&
                                recordDate <= cycleEndDate
                            );
                        })
                        .reduce((map, record) => {
                            let key = record.locationId;
                            
                            // Se tiver pai (é rua), a chave é o ID do pai (bairro) + serviço
                            const location = locations.find(l => l.id === record.locationId);
                            if (location && location.parentId) {
                                key = `${location.parentId}-${record.serviceType}`; 
                            } else {
                                // Se for local simples ou bairro, a chave é o ID do local + serviço
                                key = `${record.locationId}-${record.serviceType}`; 
                            }
                            
                            // Apenas mantém o primeiro registro encontrado para evitar duplicação de contagem de metragem
                            if (!map.has(key)) {
                                map.set(key, record);
                            }
                            return map;
                        }, new Map<string, ServiceRecord>());

                    // Soma as metragens mestres ou as metragens do registro
                    const realizedArea = Array.from(uniqueRecordsInCycle.values())
                        .reduce((sum, r) => sum + getMasterMeasurement(r), 0);
                        
                    // --------------------------------------------------------------------------------

                    const percentage = goal.targetArea > 0 ? (realizedArea / goal.targetArea) * 100 : 0;
                    const serviceName = service?.name || 'Serviço não encontrado';
                    const serviceUnit = service?.unit.symbol || '';

                    return (
                        <li key={goal.id} className="card list-item progress-card">
                            <div className="list-item-header">
                                <h3>{goal.contractGroup} - {serviceName}</h3>
                                <div>
                                    <button className="button button-sm admin-button" onClick={() => handleEditGoal(goal)}>Editar</button>
                                    <button className="button button-sm button-danger" onClick={() => handleDeleteGoal(goal.id)}>Excluir</button>
                                </div>
                            </div>
                            {/* EXIBIÇÃO DO CICLO DE MEDIÇÃO REAL */}
                            <p style={{color: 'var(--dark-gray-color)', marginTop: '-0.75rem', marginBottom: '1rem'}}>{goal.month} (Ciclo: {cycleStartDate.toLocaleDateString('pt-BR')} a {cycleEndDate.toLocaleDateString('pt-BR')})</p>
                            <div className="progress-info">
                                <span>Realizado: {realizedArea.toLocaleString('pt-BR')} / {goal.targetArea.toLocaleString('pt-BR')} {serviceUnit}</span>
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
            <div className="detail-section" style={{textAlign: 'left', marginBottom: '1.5rem'}}>
                <p><strong>Contrato/Cidade:</strong> {service.contractGroup}</p>
                <p><strong>Serviço:</strong> {service.serviceType}</p>
                 {service.serviceOrderNumber && <p><strong>Ordem de Serviço:</strong> {service.serviceOrderNumber}</p>}
                <p><strong>Local:</strong> {service.locationName}</p>
                <p><strong>Início:</strong> {service.startTime ? formatDateTime(service.startTime) : 'N/A'}</p>
            </div>
            <p>O registro inicial e as fotos "Antes" foram salvos. Complete o serviço no local.</p>
            <p>Quando terminar, clique no botão abaixo para tirar as fotos "Depois".</p>
            <button className="button button-success" style={{marginTop: '1.5rem'}} onClick={onFinish}>
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

    // Helper para converter ISO string para o formato do input datetime-local com segurança
    const toInputDate = (isoString?: string) => {
        if (!isoString) return "";
        try {
            const date = new Date(isoString);
            // Ajuste de fuso horário para exibir corretamente no input local
            const offset = date.getTimezoneOffset() * 60000;
            const localDate = new Date(date.getTime() - offset);
            return localDate.toISOString().slice(0, 16);
        } catch (e) {
            return "";
        }
    };

    const handleSave = async (isPhotoUpload = false) => {
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
            
            // Se for upload de foto, apenas atualiza o estado e não retorna (para permitir o próximo passo)
            if (isPhotoUpload) {
                setFormData(fullRecord);
                return fullRecord; // Retorna para ser usado no photoUpload
            }
            
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
        
        // CORREÇÃO 2: Salva as alterações de texto ANTES de fazer o upload
        setIsLoading("Salvando informações e enviando fotos...");
        let updatedRecord: ServiceRecord;
        try {
            // Salva os dados de texto do formulário primeiro
            updatedRecord = await handleSave(true) as ServiceRecord; 
        } catch (e) {
            alert("Erro ao salvar as alterações de texto. Não foi possível prosseguir com o upload.");
            setIsLoading(null);
            return;
        }

        // Continua com o upload
        const formDataUpload = new FormData();
        formDataUpload.append("phase", phase);
        Array.from(files).forEach(file => formDataUpload.append("files", file));
        
        try {
            await apiFetch(`/api/records/${updatedRecord.id}/photos`, { 
                method: "POST",
                body: formDataUpload
            });
            
            // --- NOVA CORREÇÃO PARA O PROBLEMA DO TIMESTAMP (Admin/Fiscal) ---
            // Se o usuário é Admin ou Fiscal, garantimos que o startTime e endTime originais sejam mantidos.
            if (currentUser?.role === 'ADMIN' || currentUser?.role === 'FISCAL') {
                 // Enviamos um novo PUT request com os valores de startTime e endTime que estavam no formulário (formData)
                 // que são os valores originais ou os editados pelo admin/fiscal, revertendo o timestamp do upload.
                 const timestampFixPayload = {
                     // Usamos os valores ATUAIS do formulário
                     startTime: formData.startTime, 
                     endTime: formData.endTime,
                     serviceOrderNumber: formData.serviceOrderNumber 
                 };
                 await apiFetch(`/api/records/${updatedRecord.id}`, {
                     method: 'PUT',
                     body: JSON.stringify(timestampFixPayload),
                 });
            }
            // --- FIM DA NOVA CORREÇÃO ---

            // Busca o registro mais recente (agora com o timestamp corrigido)
            const freshRecord = await apiFetch(`/api/records/${updatedRecord.id}`);
            const fullRecord = {
                ...freshRecord,
                id: String(freshRecord.id),
                operatorId: String(freshRecord.operatorId),
            };
            setFormData(fullRecord); 
            alert("Fotos adicionadas com sucesso!");
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

            // Salva as alterações, incluindo a lista de fotos modificada
            const updated = await apiFetch(`/api/records/${formData.id}`, {
                method: "PUT",
                body: JSON.stringify({
                    ...formData,
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
    
    // CORREÇÃO 1: Função para abrir imagem em tela cheia (usando o prop do App)
    const handleViewImage = (src: string) => {
        (window as any).viewImage(`${API_BASE}${src}`);
    };

    return (
        <div className="card edit-form-container">
            <h3>{isOperator ? 'Adicionar Fotos/Informações' : 'Editar Registro de Serviço'}</h3>
            <div className="form-group">
                <label>Nº Ordem de Serviço</label>
                <input
                    type="text"
                    value={formData.serviceOrderNumber || ''}
                    onChange={e => handleChange("serviceOrderNumber", e.target.value.toUpperCase())}
                    onBlur={e => handleChange("serviceOrderNumber", e.target.value.toUpperCase())}
                    readOnly={isOperator}
                />
            </div>
            <div className="form-group">
                <label>Nome do Local</label>
                <input
                    type="text"
                    value={formData.locationName}
                    onChange={e => handleChange("locationName", e.target.value.toUpperCase())}
                    onBlur={e => handleChange("locationName", e.target.value.toUpperCase())}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Tipo de Serviço</label>
                <input
                    type="text"
                    value={formData.serviceType}
                    onChange={e => handleChange("serviceType", e.target.value.toUpperCase())}
                    onBlur={e => handleChange("serviceType", e.target.value.toUpperCase())}
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
                <label>Observações</label>
                <textarea 
                    className="input-field"
                    style={{ minHeight: '100px', resize: 'vertical', width: '100%' }}
                    value={formData.observations || ''}
                    onChange={(e) => handleChange("observations", e.target.value.toUpperCase())}
                    onBlur={(e) => handleChange("observations", e.target.value.toUpperCase())}
                    placeholder="Edite ou adicione observações sobre este serviço..."
                />
            </div>

            <div className="form-group">
                <label>Unidade</label>
                <select
                    value={formData.serviceUnit}
                    onChange={e => handleChange("serviceUnit", e.target.value as 'm²' | 'm linear')}
                    disabled={isOperator}
                >
                    <option value="m²">M²</option>
                    <option value="m linear">M LINEAR</option>
                </select>
            </div>

            <div className="form-group">
                <label>Contrato/Cidade</label>
                <input
                    type="text"
                    value={formData.contractGroup}
                    onChange={e => handleChange("contractGroup", e.target.value.toUpperCase())}
                    onBlur={e => handleChange("contractGroup", e.target.value.toUpperCase())}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Início</label>
                <input
                    type="datetime-local"
                    value={toInputDate(formData.startTime)}
                    onChange={e => handleChange("startTime", new Date(e.target.value).toISOString())}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <label>Fim</label>
                <input
                    type="datetime-local"
                    value={toInputDate(formData.endTime)}
                    onChange={e => {
                        // Só atualiza se o usuário realmente inseriu um valor válido
                        if (e.target.value) {
                            handleChange("endTime", new Date(e.target.value).toISOString());
                        }
                    }}
                    readOnly={isOperator}
                />
            </div>

            <div className="form-group">
                <h4>Fotos "Antes" ({(formData.beforePhotos || []).length})</h4>
                <div className="edit-photo-gallery">
                    {(formData.beforePhotos || []).map((p, i) => (
                        <div key={`b-${i}`} className="edit-photo-item">
                            <button onClick={() => handleViewImage(p)} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
                                <img src={`${API_BASE}${p}`} alt={`Antes ${i+1}`} />
                            </button>
                            <button className="delete-photo-btn" onClick={() => handlePhotoRemove(p)}>&times;</button>
                        </div>
                    ))}
                </div>
                <label htmlFor="before-upload" className="button button-sm" style={{marginTop: '0.5rem'}}>Adicionar Foto "Antes"</label>
                <input id="before-upload" type="file" accept="image/*" multiple onChange={e => handlePhotoUpload("BEFORE", e.target.files)} style={{display: 'none'}} />
            </div>

            <div className="form-group">
                <h4>Fotos "Depois" ({(formData.afterPhotos || []).length})</h4>
                <div className="edit-photo-gallery">
                    {(formData.afterPhotos || []).map((p, i) => (
                        <div key={`a-${i}`} className="edit-photo-item">
                            <button onClick={() => handleViewImage(p)} style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
                                <img src={`${API_BASE}${p}`} alt={`Depois ${i+1}`} />
                            </button>
                             <button className="delete-photo-btn" onClick={() => handlePhotoRemove(p)}>&times;</button>
                        </div>
                    ))}
                </div>
                <label htmlFor="after-upload" className="button button-sm" style={{marginTop: '0.5rem'}}>Adicionar Foto "Depois"</label>
                <input id="after-upload" type="file" accept="image/*" multiple onChange={e => handlePhotoUpload("AFTER", e.target.files)} style={{display: 'none'}} />
            </div>

            <div className="button-group">
                <button className="button button-secondary" onClick={onCancel}>Voltar</button>
                <button className="button button-success" onClick={() => handleSave()}>Salvar Alterações</button>
            </div>
        </div>
    );
};

const AuditLogView: React.FC<{ log: AuditLogEntry[] }> = ({ log }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const ITEMS_PER_PAGE = 10;

    const filteredLog = useMemo(() => {
        // 1. NORMALIZA O TERMO DE BUSCA UMA VEZ
        const normalizedSearchTerm = normalizeString(searchTerm);
        
        return log.filter(entry => 
            // APLICA A NORMALIZAÇÃO NOS CAMPOS DE BUSCA
            normalizeString(entry.details).includes(normalizedSearchTerm) ||
            normalizeString(entry.adminUsername).includes(normalizedSearchTerm) ||
            normalizeString(entry.action).includes(normalizedSearchTerm) ||
            String(entry.recordId).includes(searchTerm)
        ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }, [log, searchTerm]);

    const totalPages = Math.ceil(filteredLog.length / ITEMS_PER_PAGE);
    const currentLogs = filteredLog.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => { setCurrentPage(1); }, [searchTerm]);

    const handleExportExcel = async () => {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Log de Auditoria');

        worksheet.columns = [
            { header: 'Data/Hora', key: 'timestamp', width: 20 },
            { header: 'Usuário', key: 'username', width: 20 },
            { header: 'Ação', key: 'action', width: 20 },
            { header: 'ID Registro', key: 'recordId', width: 15 },
            { header: 'Detalhes', key: 'details', width: 50 },
        ];

        filteredLog.forEach(entry => {
            worksheet.addRow({
                timestamp: formatDateTime(entry.timestamp),
                username: entry.adminUsername,
                action: entry.action === 'UPDATE' ? 'Atualização' : entry.action === 'DELETE' ? 'Exclusão' : 'Ajuste de Medição',
                recordId: entry.recordId,
                details: entry.details
            });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `log_auditoria_${new Date().toISOString().split('T')[0]}.xlsx`;
        link.click();
    };

    return (
        <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2>Registros de Alterações</h2>
                <button className="button admin-button" onClick={handleExportExcel} disabled={filteredLog.length === 0}>
                    Exportar para Excel
                </button>
            </div>

            <SearchBar value={searchTerm} onChange={setSearchTerm} placeholder="Buscar por usuário, detalhes ou ID..." />

            {currentLogs.length === 0 ? (
                <p>Nenhuma alteração encontrada com os filtros atuais.</p>
            ) : (
                <>
                    <ul className="audit-log-list">
                        {currentLogs.map(entry => (
                            <li key={entry.id} className="audit-log-item" style={{borderBottom: '1px solid #eee', paddingBottom: '1rem', marginBottom: '1rem'}}>
                                <p><strong>Data:</strong> {formatDateTime(entry.timestamp)}</p>
                                <p><strong>Usuário:</strong> {entry.adminUsername}</p>
                                <p><strong>Ação:</strong> {entry.action === 'UPDATE' ? 'Atualização de Registro' : entry.action === 'DELETE' ? 'Exclusão de Registro' : 'Ajuste de Medição'}</p>
                                <p><strong>ID do Registro:</strong> {entry.recordId}</p>
                                <p><strong>Detalhes:</strong> {entry.details}</p>
                            </li>
                        ))}
                    </ul>
                    <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
                </>
            )}
        </div>
    );
};

const ManageServicesView: React.FC<{
    services: ServiceDefinition[];
    fetchData: () => Promise<void>;
}> = ({ services, fetchData }) => {
    const [serviceName, setServiceName] = useState('');
    const [selectedUnitId, setSelectedUnitId] = useState('');
    const [editingServiceId, setEditingServiceId] = useState<string | null>(null);

    const [units, setUnits] = useState<Unit[]>([]);
    const [unitName, setUnitName] = useState('');
    const [unitSymbol, setUnitSymbol] = useState('');
    const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
    
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const fetchUnits = async () => {
            try {
                const fetchedUnits = await apiFetch('/api/units');
                setUnits(fetchedUnits);
            } catch (error) {
                console.error("Failed to fetch units", error);
                alert("Não foi possível carregar as unidades de medida.");
            }
        };
        fetchUnits();
    }, []);

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
            const payload = { name: unitName.toUpperCase(), symbol: unitSymbol.toUpperCase() }; // Caixa alta
            if (editingUnitId) {
                await apiFetch(`/api/units/${editingUnitId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/units', { method: 'POST', body: JSON.stringify(payload) });
            }
            resetUnitForm();
            await fetchData();
            const fetchedUnits = await apiFetch('/api/units');
            setUnits(fetchedUnits);

        } catch (error) {
            alert('Falha ao salvar a unidade.');
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
                setUnits(fetchedUnits);
            } catch (error: any) {
                alert(`Falha ao excluir: ${error.message}`);
            } finally {
                setIsLoading(false);
            }
        }
    };

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
            const payload = { name: serviceName.toUpperCase(), unitId: parseInt(selectedUnitId) }; // Caixa alta
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
        setSelectedUnitId(String(service.unitId));
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
            <div className="card">
                <h3>Gerenciar Unidades de Medida</h3>
                <div className="form-container add-service-form" style={{alignItems: 'flex-end'}}>
                    <input type="text" placeholder="Nome da Unidade (ex: HORAS)" value={unitName} onChange={e => setUnitName(e.target.value.toUpperCase())} onBlur={e => setUnitName(e.target.value.toUpperCase())} />
                    <input type="text" placeholder="Símbolo (ex: H)" value={unitSymbol} onChange={e => setUnitSymbol(e.target.value.toUpperCase())} onBlur={e => setUnitSymbol(e.target.value.toUpperCase())} style={{flexGrow: 0, width: '100px'}}/>
                    <button className="button admin-button" onClick={handleSaveUnit} disabled={isLoading}>
                        {editingUnitId ? 'Salvar' : 'Adicionar'}
                    </button>
                    {editingUnitId && <button className="button button-secondary" onClick={resetUnitForm}>Cancelar</button>}
                </div>
                <ul className="location-list" style={{marginTop: '1.5rem'}}>
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

            <div className="card" style={{ marginTop: '2rem' }}>
                <h3>Gerenciar Tipos de Serviço</h3>
                <div className="form-container add-service-form" style={{alignItems: 'flex-end'}}>
                    <input type="text" placeholder="Nome do Serviço" value={serviceName} onChange={e => setServiceName(e.target.value.toUpperCase())} onBlur={e => setServiceName(e.target.value.toUpperCase())} />
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
                <ul className="location-list" style={{marginTop: '1.5rem'}}>
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

// --- Função auxiliar para determinar a view inicial ---
const getInitialView = (): View => {
    const path = window.location.pathname;
    if (path.endsWith('/reset-password')) return 'RESET_PASSWORD';
    if (path.endsWith('/forgot-password')) return 'FORGOT_PASSWORD';
    return 'LOGIN';
};

// --- Componente Principal ---
const App = () => {
    const [view, setView] = useState<View>(getInitialView());
    const [currentUser, setCurrentUser] = useLocalStorage<User | null>('crbCurrentUser', null);
    const [users, setUsers] = useState<User[]>([]);
    const [locations, setLocations] = useState<LocationRecord[]>([]);
    const [records, setRecords] = useState<ServiceRecord[]>([]);
    const [services, setServices] = useState<ServiceDefinition[]>([]);
    const [contractConfigs, setContractConfigs] = useState<ContractConfig[]>([]);
    const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
    const [currentService, setCurrentService] = useLocalStorage<Partial<ServiceRecord>>('crbCurrentService', {});
    const [selectedRecord, setSelectedRecord] = useState<ServiceRecord | null>(null);
    const [selectedContractGroup, setSelectedContractGroup] = useState<string | null>(null);
    const [selectedLocation, setSelectedLocation] = useState<(LocationRecord & { _gpsUsed?: boolean }) | null>(null);
    const [history, setHistory] = useState<View[]>([]);
    const [isLoading, setIsLoading] = useState<string | null>(null);
    const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());
    
    // CORREÇÃO 1: Estados para o ImageViewer
    const [isViewingImage, setIsViewingImage] = useState(false);
    const [viewingImageSrc, setViewingImageSrc] = useState('');
    
    // CORREÇÃO 3: Mapeamento da medição de Local/Bairro por Serviço
    const locationServiceMap: LocationRecordServiceMap = useMemo(() => {
        return locations.reduce((acc, loc) => {
            acc[loc.id] = (loc.services || []).reduce((srvAcc, srv) => {
                srvAcc[srv.serviceId] = srv.measurement;
                return srvAcc;
            }, {} as { [serviceId: string]: number; });
            return acc;
        }, {} as LocationRecordServiceMap);
    }, [locations]);

    // CORREÇÃO 1: Função para abrir o ImageViewer
    const handleViewImage = (src: string) => {
        setViewingImageSrc(src);
        setIsViewingImage(true);
    };

    const handleCloseImageViewer = () => {
        setIsViewingImage(false);
        setViewingImageSrc('');
    };
    
    // CORREÇÃO 1: Expõe a função para uso nos componentes aninhados (AdminEditRecordView)
    useEffect(() => {
        (window as any).viewImage = handleViewImage;
    }, []);

    const handleToggleRecordSelection = (recordId: string) => {
        setSelectedRecordIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(recordId)) newSet.delete(recordId);
            else newSet.add(recordId);
            return newSet;
        });
    };
    
    const addAuditLogEntry = async (action: 'UPDATE' | 'DELETE' | 'ADJUST_MEASUREMENT', details: string, recordId?: string) => {
        if (!currentUser || currentUser.role !== 'ADMIN') return;
        try {
            await apiFetch('/api/auditlog', {
                method: 'POST',
                body: JSON.stringify({ action, recordId: recordId ? parseInt(recordId) : 0, details })
            });
            await fetchAuditLog();
        } catch (error) { console.error("Failed to add audit log entry", error); }
    };
    
    const fetchAuditLog = async () => {
        if (currentUser?.role !== 'ADMIN') return;
        try { setAuditLog(await apiFetch('/api/auditlog')); }
        catch (error) { console.error("Failed to fetch audit log", error); }
    };

    const handleDeleteSelectedRecords = async () => {
        if (selectedRecordIds.size === 0 || !window.confirm(`Tem certeza que deseja excluir os ${selectedRecordIds.size} registros selecionados?`)) return;
        setIsLoading("Excluindo registros...");
        try {
            await Promise.all(Array.from(selectedRecordIds).map(id => apiFetch(`/api/records/${id}`, { method: 'DELETE' })));
            setRecords(prev => prev.filter(r => !selectedRecordIds.has(r.id)));
            setSelectedRecordIds(new Set());
            alert("Registros excluídos com sucesso.");
        } catch (e) {
            alert("Falha ao excluir um ou mais registros.");
            console.error(e);
        } finally { setIsLoading(null); }
    };

    useEffect(() => {
        const handleSyncSuccess = (event: Event) => {
            const { tempId, newId } = (event as CustomEvent).detail;
            setCurrentService(prev => (prev.id === tempId || prev.tempId === tempId) ? { ...prev, id: String(newId) } : prev);
        };
        window.addEventListener('syncSuccess', handleSyncSuccess);
        return () => window.removeEventListener('syncSuccess', handleSyncSuccess);
    }, [setCurrentService]);

    const navigate = (newView: View, replace = false) => {
        if (['ADMIN_DASHBOARD', 'FISCAL_DASHBOARD', 'OPERATOR_GROUP_SELECT', 'LOGIN'].includes(newView)) {
            window.history.pushState({}, '', '/');
            setHistory([]);
        } else {
            if (!replace) setHistory(h => [...h, view]);
        }
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
        if (user.role === 'ADMIN') navigate('ADMIN_DASHBOARD', true);
        else if (user.role === 'OPERATOR') navigate('OPERATOR_GROUP_SELECT', true);
        else if (user.role === 'FISCAL') navigate('FISCAL_DASHBOARD', true);
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
            const [locs, recs, srvs, configs, usrs, logs] = await Promise.all([
                apiFetch(`/api/locations?t=${Date.now()}`),
                apiFetch(`/api/records?t=${Date.now()}`),
                apiFetch(`/api/services?t=${Date.now()}`),
                apiFetch('/api/contract-configs'),
                currentUser.role === 'ADMIN' ? apiFetch('/api/users') : Promise.resolve(null),
                currentUser.role === 'ADMIN' ? apiFetch('/api/auditlog') : Promise.resolve(null),
            ]);
            
            setLocations(locs.map((l: any) => ({ ...l, id: String(l.id), isGroup: !!l.isGroup, parentId: l.parentId ? String(l.parentId) : null, services: (l.services || []).map((s: any) => ({ ...s, serviceId: String(s.serviceId) })) })));
            setServices(srvs.map((s: any) => ({...s, id: String(s.id), unitId: String(s.unitId) })));
            setContractConfigs(configs || []);
            
            const mapRecord = (r: any) => ({ ...r, id: String(r.id), operatorId: String(r.operatorId), locationId: r.locationId ? String(r.locationId) : undefined });

            if (currentUser.role === 'ADMIN') {
                setRecords(recs.map(mapRecord));
                if (usrs) setUsers(usrs.map((u: any) => ({...u, id: String(u.id), username: u.name })));
                if(logs) setAuditLog(logs);
            } else if (currentUser.role === 'OPERATOR') {
                setRecords(recs.filter((r: any) => String(r.operatorId) === String(currentUser.id)).map(mapRecord));
            } else {
                const fiscalGroups = new Set(currentUser.assignments?.map(a => a.contractGroup) || []);
                setRecords(recs.filter((r: any) => fiscalGroups.has(r.contractGroup)).map(mapRecord));
            }
        } catch (error) {
            console.error("Failed to fetch data", error);
            alert("Não foi possível carregar os dados do servidor.");
            handleLogout();
        } finally { setIsLoading(null); }
    };

    useEffect(() => {
        if (view === 'RESET_PASSWORD' || view === 'FORGOT_PASSWORD') return;
        const restoreSession = async () => {
            if (API_TOKEN) {
                setIsLoading("Verificando sessão...");
                try {
                    const me = await apiFetch('/api/auth/me');
                    const user: User = { id: String(me.id), username: me.name, email: me.email, role: me.role, assignments: me.assignments || [] };
                    setCurrentUser(user);
                    if (view === 'LOGIN') redirectUser(user);
                } catch (error) {
                    console.error("Session restore failed", error);
                    handleLogout();
                } finally { setIsLoading(null); }
            }
        };
        restoreSession();
    }, []);

    useEffect(() => { if (currentUser) { fetchData(); } }, [currentUser]);

    const resetService = () => {
        setCurrentService({});
        setSelectedContractGroup(null);
        setSelectedLocation(null);
        if(currentUser) redirectUser(currentUser);
    }

    const handleLogin = (user: User) => {
        setCurrentUser(user);
        redirectUser(user);
    };

    const handleGroupSelect = (group: string) => {
        setSelectedContractGroup(group);
        navigate('OPERATOR_LOCATION_SELECT');
    }

    const handleLocationSelect = (location: LocationRecord, gpsUsed: boolean) => {
        setSelectedLocation({ ...location, _gpsUsed: gpsUsed });
        navigate('OPERATOR_SERVICE_SELECT');
    };

    const startNewServiceRecord = (service: ServiceDefinition, measurement?: number) => {
        if (!selectedLocation) return;
        const isManual = selectedLocation.id.startsWith('manual-');
        
        let locationArea: number | undefined;

        if (isManual) {
            // É um local manual, usa a medição informada.
            locationArea = measurement;
        } else if (selectedLocation.parentId) {
            // CORREÇÃO 3: É uma rua dentro de um bairro, busca a medição do PAI.
            const parentLocationId = selectedLocation.parentId;
            const serviceId = service.id;
            locationArea = locationServiceMap[parentLocationId]?.[serviceId];
        } else {
            // É um local autônomo (ou um bairro), pega a medição diretamente dele.
            const serviceDetail = selectedLocation.services?.find(s => s.serviceId === service.id);
            locationArea = serviceDetail?.measurement;
        }

        if (locationArea === undefined || isNaN(locationArea)) {
            // Se não encontrou no pai/local, tenta a medição manual se estiver definida
            locationArea = measurement ?? 0;
            if (locationArea === 0) {
                 alert("Erro: Medição não encontrada para este serviço/local. Contate o administrador.");
                 return;
            }
        }

        setCurrentService({
            serviceId: parseInt(service.id),
            serviceType: service.name,
            serviceUnit: service.unit.symbol,
            contractGroup: selectedLocation.contractGroup,
            locationId: isManual ? undefined : selectedLocation.id,
            locationName: selectedLocation.name,
            locationArea: locationArea,
            gpsUsed: selectedLocation._gpsUsed || false,
            coords: selectedLocation.coords
        });
        navigate('PHOTO_STEP');
    };
    
    const handleServiceSelect = (service: ServiceDefinition, measurement?: number) => {
        if (!selectedLocation) return;
        if (selectedLocation.id.startsWith('manual-')) {
            startNewServiceRecord(service, measurement);
            return;
        }
        
        const config = contractConfigs.find(c => c.contractGroup === selectedLocation.contractGroup);
        const cycleStartDay = config ? config.cycleStartDay : 1;
        const today = new Date();
        let cycleStartDate = new Date(today.getFullYear(), today.getMonth(), cycleStartDay);
        if (today.getDate() < cycleStartDay) cycleStartDate.setMonth(cycleStartDate.getMonth() - 1);
        cycleStartDate.setHours(0, 0, 0, 0);

        const existingRecord = records.find(r => r.locationId === selectedLocation.id && r.serviceType === service.name && new Date(r.startTime) >= cycleStartDate);

        if (existingRecord) {
            if (window.confirm("Este serviço já foi feito neste ciclo.\n\nOK = Iniciar NOVO registro.\nCancelar = Adicionar fotos 'Depois' ao existente.")) {
                startNewServiceRecord(service);
            } else {
                // Ao reabrir um registro, atualiza o estado para garantir que ele tenha todos os dados de ID e fotos
                setCurrentService({
                    ...existingRecord,
                    // Garante que a medição (locationArea) seja a do registro existente
                    locationArea: existingRecord.locationArea 
                });
                navigate('PHOTO_STEP');
            }
        } else {
            startNewServiceRecord(service);
        }
    };
    
const handleBeforePhotos = async (photosBefore: string[], serviceOrderNumber?: string) => {
        setIsLoading("Salvando fotos...");
        try {
            // 1. Tenta pegar o ID do estado atual
            let recordId = currentService.id && !currentService.tempId ? currentService.id : currentService.tempId;
            let isEditing = !!recordId;

            // --- TRAVA DE SEGURANÇA CONTRA DUPLICAÇÃO ---
            // Se o app acha que é novo (isEditing = false), vamos conferir no banco se não é engano.
            if (!isEditing) {
                const pending = await getPendingRecords();
                // Procura um registro pendente para o MESMO local e MESMO serviço feito pelo usuário
                const existingDraft = pending.find(r => 
                    r.payload.operatorId === currentUser!.id &&
                    r.payload.locationId === currentService.locationId &&
                    r.payload.serviceType === currentService.serviceType
                );

                if (existingDraft) {
                    console.log("Recuperado registro pendente existente para evitar duplicação:", existingDraft.payload.tempId);
                    // Força o uso do registro existente
                    recordId = existingDraft.payload.tempId;
                    isEditing = true;
                    
                    // Atualiza o estado atual para o app "lembrar" dele
                    setCurrentService(prev => ({
                        ...prev,
                        ...existingDraft.payload,
                        id: existingDraft.payload.tempId,
                        tempId: existingDraft.payload.tempId,
                        // Mantém as fotos antigas que estavam no banco + as novas
                        beforePhotos: [...(existingDraft.photosBefore || []).map(() => ""), ...prev.beforePhotos || []] 
                    }));
                }
            }
            // ---------------------------------------------

            const newFiles = photosBefore.map((p, i) => 
                dataURLtoFile(p, `before_append_${Date.now()}_${i}.jpg`)
            );

            if (isEditing && recordId) { // Verifica recordId novamente pois a trava pode ter mudado ele
                // --- MODO ADIÇÃO (Anexar ao existente) ---
                
                // Verifica se é ID de servidor (número/string curto) ou TempId (UUID longo)
                const isServerId = currentService.id && !currentService.tempId && !recordId.includes("-"); // verificação simples

                if (isServerId) {
                    // Online: Manda pra API
                    const fd = new FormData();
                    fd.append("phase", "BEFORE");
                    newFiles.forEach(f => fd.append("files", f));
                    
                    // Também envia a O.S. atualizada, se houver
                    if (serviceOrderNumber) {
                         await apiFetch(`/api/records/${currentService.id}`, { 
                            method: 'PUT', 
                            body: JSON.stringify({ serviceOrderNumber: serviceOrderNumber.toUpperCase() }) 
                         });
                    }

                    await apiFetch(`/api/records/${currentService.id}/photos`, { method: 'POST', body: fd });
                } else {
                    // Offline/Pendente: Atualiza no IndexedDB usando o ID recuperado
                    await addBeforePhotosToPending(recordId, newFiles, serviceOrderNumber?.toUpperCase());
                }

                setCurrentService(prev => ({
                    ...prev,
                    beforePhotos: [...(prev.beforePhotos || []), ...photosBefore],
                    serviceOrderNumber: serviceOrderNumber?.toUpperCase() || prev.serviceOrderNumber
                }));

                navigate('OPERATOR_SERVICE_IN_PROGRESS');

            } else {
                // --- MODO CRIAÇÃO REAL (Só se realmente não achou nada no banco) ---
                
                const newTempId = crypto.randomUUID();
                const { serviceId, serviceType, serviceUnit, locationId, locationName, contractGroup, locationArea, gpsUsed, coords } = currentService;

                const recordPayload = {
                    operatorId: currentUser!.id,
                    serviceId,
                    serviceType,
                    serviceUnit,
                    locationId,
                    locationName,
                    contractGroup,
                    locationArea,
                    gpsUsed: !!gpsUsed,
                    startTime: new Date().toISOString(),
                    serviceOrderNumber: serviceOrderNumber?.trim().toUpperCase() || undefined,
                    tempId: newTempId,
                    newLocationInfo: !locationId ? {
                        name: locationName,
                        city: contractGroup,
                        lat: coords?.latitude,
                        lng: coords?.longitude,
                        parentId: (selectedLocation as any)?.parentId,
                        services: [{ service_id: services.find(s => s.name === serviceType)?.id, measurement: locationArea }]
                    } : undefined
                };

                // Cria o registro novo
                await queueRecord(recordPayload, newFiles);

                setCurrentService(prev => ({
                    ...prev,
                    ...recordPayload,
                    id: newTempId,
                    tempId: newTempId,
                    beforePhotos: photosBefore
                }));

                navigate('OPERATOR_SERVICE_IN_PROGRESS');
            }
        } catch (err) {
            console.error("Falha ao salvar registro:", err);
            alert("Falha ao salvar. Tente novamente.");
        } finally {
            setIsLoading(null);
        }
    };

    const handleAfterPhotos = async (photosAfter: string[]) => {
        setIsLoading("Salvando fotos 'Depois'...");
        try {
            const afterFiles = photosAfter.map((p, i) => dataURLtoFile(p, `after_${i}.jpg`));
            await addAfterPhotosToPending(currentService.id || currentService.tempId!, afterFiles);
            navigate('CONFIRM_STEP');
        } catch (err) {
            console.error(err);
            alert("Falha ao salvar fotos localmente.");
        } finally { setIsLoading(null); }
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
            setSelectedRecord({ ...detailedRecord, id: String(detailedRecord.id), operatorId: String(detailedRecord.operatorId) });
            navigate('DETAIL');
        } catch (e) {
            alert('Não foi possível carregar os detalhes do registro.');
        } finally { setIsLoading(null); }
    }

    const handleEditRecord = async (record: ServiceRecord) => {
        setIsLoading("Carregando registro para edição...");
        try {
            const detailedRecord = await apiFetch(`/api/records/${record.id}`);
            setSelectedRecord({ ...detailedRecord, id: String(detailedRecord.id), operatorId: String(detailedRecord.operatorId) });
            navigate('ADMIN_EDIT_RECORD');
        } catch(e) {
             alert('Não foi possível carregar o registro para edição.');
        } finally { setIsLoading(null); }
    };

    const handleUpdateRecord = (updatedRecord: ServiceRecord) => {
        setRecords(prev => prev.map(r => r.id === updatedRecord.id ? { ...r, ...updatedRecord } : r));
        handleBack();
    };

    const handleDeleteRecord = async (recordId: string) => {
        if (!currentUser || currentUser.role !== 'ADMIN') return;
        const recordToDelete = records.find(r => r.id === recordId);
        if (recordToDelete && window.confirm(`Tem certeza que deseja excluir o registro do local "${recordToDelete.locationName}"?`)) {
            try {
                setIsLoading("Excluindo registro...");
                await apiFetch(`/api/records/${recordId}`, { method: 'DELETE' });
                setRecords(prev => prev.filter(r => r.id !== recordId));
                alert("Registro excluído com sucesso.");
            } catch(e) {
                alert("Falha ao excluir o registro.");
            } finally { setIsLoading(null); }
        }
    };

    const handleMeasurementUpdate = async (recordId: number, newMeasurementValue: string) => {
        setIsLoading("Ajustando medição...");
        try {
            const response = await apiFetch(`/api/records/${recordId}/measurement`, {
                method: 'PUT',
                body: JSON.stringify({ overrideMeasurement: newMeasurementValue }),
            });
            setRecords(prevRecords => prevRecords.map(r => r.id === String(recordId) ? { ...r, ...response } : r));
            addAuditLogEntry('ADJUST_MEASUREMENT', `Medição do registro ${recordId} ajustada para ${newMeasurementValue}`, String(recordId));
        } catch (error) {
            console.error("Erro ao salvar medição:", error);
            alert('Não foi possível salvar a medição ajustada.');
        } finally { setIsLoading(null); }
    };

    const renderView = () => {
        if (view === 'RESET_PASSWORD') return <ResetPasswordView />;
        if (view === 'FORGOT_PASSWORD') return <ForgotPasswordView />;
        if (!currentUser) return <Login onLogin={handleLogin} onNavigate={navigate} />;
        
        switch(currentUser.role) {
            case 'ADMIN':
                switch(view) {
                    case 'ADMIN_DASHBOARD': return <AdminDashboard onNavigate={navigate} onLogout={handleLogout} />;
                    case 'ADMIN_MANAGE_SERVICES': return <ManageServicesView services={services} fetchData={fetchData} />;
                    case 'ADMIN_MANAGE_LOCATIONS': return <ManageLocationsView locations={locations} services={services} fetchData={fetchData} addAuditLogEntry={addAuditLogEntry} />;
                    case 'ADMIN_MANAGE_USERS': return <ManageUsersView users={users} onUsersUpdate={fetchData} services={services} locations={locations} />;
                    case 'ADMIN_MANAGE_GOALS': return <GoalsAndChartsView records={records} locations={locations} services={services} contractConfigs={contractConfigs} locationServiceMap={locationServiceMap} />;
                    case 'ADMIN_MANAGE_CYCLES': return <ManageCyclesView locations={locations} configs={contractConfigs} fetchData={fetchData} />;
                    case 'REPORTS': return <ReportsView records={records} services={services} locations={locations} />;
                    case 'HISTORY': return <HistoryView records={records} onSelect={handleSelectRecord} isAdmin={true} onEdit={handleEditRecord} onDelete={handleDeleteRecord} selectedIds={selectedRecordIds} onToggleSelect={handleToggleRecordSelection} onDeleteSelected={handleDeleteSelectedRecords} onMeasurementUpdate={handleMeasurementUpdate} onViewImage={handleViewImage} />;
                    case 'DETAIL': return selectedRecord ? <DetailView record={selectedRecord} onViewImage={handleViewImage} /> : <p>Registro não encontrado.</p>;
                    case 'ADMIN_EDIT_RECORD': return selectedRecord ? <AdminEditRecordView record={selectedRecord} onSave={handleUpdateRecord} onCancel={handleBack} setIsLoading={setIsLoading} currentUser={currentUser} /> : <p>Nenhum registro selecionado.</p>;
                    case 'AUDIT_LOG': return <AuditLogView log={auditLog} />;
                    default: return <AdminDashboard onNavigate={navigate} onLogout={handleLogout}/>;
                }
            
            case 'FISCAL':
                const fiscalGroups = new Set(currentUser.assignments?.map(a => a.contractGroup) || []);
                const fiscalRecords = records.filter(r => fiscalGroups.has(r.contractGroup));
                switch(view) {
                    case 'FISCAL_DASHBOARD': return <FiscalDashboard onNavigate={navigate} onLogout={handleLogout} />;
                    case 'REPORTS': return <ReportsView records={fiscalRecords} services={services} locations={locations} />;
                    case 'HISTORY': return <HistoryView records={fiscalRecords} onSelect={handleSelectRecord} isAdmin={false} selectedIds={new Set()} onToggleSelect={() => {}} onMeasurementUpdate={async () => {}} onViewImage={handleViewImage} />;
                    case 'DETAIL':
                        const canView = selectedRecord && fiscalGroups.has(selectedRecord.contractGroup);
                        return canView ? <DetailView record={selectedRecord} onViewImage={handleViewImage} /> : <p>Registro não encontrado ou acesso não permitido.</p>;
                    default: return <FiscalDashboard onNavigate={navigate} onLogout={handleLogout} />;
                }

            case 'OPERATOR':
                switch(view) {
                    case 'OPERATOR_GROUP_SELECT': return <OperatorGroupSelect user={currentUser} onSelectGroup={handleGroupSelect} onLogout={handleLogout} />;
                    case 'OPERATOR_LOCATION_SELECT': return selectedContractGroup ? <OperatorLocationSelect locations={locations} contractGroup={selectedContractGroup} onSelectLocation={handleLocationSelect} /> : <p>Nenhum contrato selecionado.</p>;
                    case 'OPERATOR_SERVICE_SELECT': return selectedLocation ? <OperatorServiceSelect location={selectedLocation} services={services} user={currentUser} onSelectService={handleServiceSelect} records={records} contractConfigs={contractConfigs} locations={locations} /> : <p>Nenhum local selecionado.</p>;
                    case 'OPERATOR_SERVICE_IN_PROGRESS': return <ServiceInProgressView service={currentService} onFinish={() => navigate('PHOTO_STEP')} />;
                    case 'PHOTO_STEP':
                        const isAfterPhase = !!(currentService.beforePhotos && currentService.beforePhotos.length > 0);
                        return <PhotoStep phase={isAfterPhase ? "AFTER" : "BEFORE"} onComplete={isAfterPhase ? handleAfterPhotos : handleBeforePhotos} onCancel={resetService} />;
                    case 'CONFIRM_STEP': return <ConfirmStep recordData={currentService} onSave={handleSave} onCancel={resetService} />;
                    case 'HISTORY': 
                        const operatorRecords = records.filter(r => String(r.operatorId) === String(currentUser.id));
                        return <HistoryView records={operatorRecords} onSelect={handleSelectRecord} isAdmin={false} onEdit={handleEditRecord} selectedIds={new Set()} onToggleSelect={() => {}} onMeasurementUpdate={async () => {}} onViewImage={handleViewImage} />;
                    case 'DETAIL': return selectedRecord ? <DetailView record={selectedRecord} onViewImage={handleViewImage} /> : <p>Registro não encontrado.</p>;
                    case 'ADMIN_EDIT_RECORD': return selectedRecord ? <AdminEditRecordView record={selectedRecord} onSave={handleUpdateRecord} onCancel={handleBack} setIsLoading={setIsLoading} currentUser={currentUser} /> : <p>Nenhum registro selecionado.</p>;
                    default: return <OperatorGroupSelect user={currentUser} onSelectGroup={handleGroupSelect} onLogout={handleLogout} />;
                }
            
            default:
                 handleLogout();
                 return null;
        }
    };

    return (
        <div className={`app-container ${view === 'LOGIN' || view === 'RESET_PASSWORD' || view === 'FORGOT_PASSWORD' ? 'login-view' : ''}`}>
            {isLoading && <div className="loader-overlay"><div className="spinner"></div><p>{isLoading}</p></div>}
            <Header view={view} currentUser={currentUser} onBack={handleBack} onLogout={handleLogout} />
            <main>{renderView()}</main>
            {/* CORREÇÃO 1: Adiciona o ImageViewer fora da estrutura da main */}
            {isViewingImage && <ImageViewer src={viewingImageSrc} onClose={handleCloseImageViewer} />}
        </div>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}
