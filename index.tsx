import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// --- API Client & Helpers ---

// A API_BASE agora é uma string vazia para permitir requisições relativas (ex: /api/login)
// que serão interceptadas pelo proxy do Nginx no Docker.
const API_BASE = (import.meta as any).env?.VITE_API_BASE || '';

let API_TOKEN: string | null = localStorage.getItem('crbApiToken');

const setApiToken = (token: string | null) => {
    API_TOKEN = token;
    if (token) {
        localStorage.setItem('crbApiToken', token);
    } else {
        localStorage.removeItem('crbApiToken');
    }
};

const apiFetch = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    if (API_TOKEN) {
        headers.append('Authorization', `Bearer ${API_TOKEN}`);
    }
    if (!(options.body instanceof FormData)) {
        headers.append('Content-Type', 'application/json');
    }

    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (!response.ok) {
        let errorBody;
        try {
            errorBody = await response.json();
        } catch (e) {
            errorBody = await response.text();
        }
        console.error("API Error:", errorBody);
        throw new Error(`API request failed with status ${response.status}`);
    }
    
    if (response.status === 204 || response.headers.get('content-length') === '0') {
        return null;
    }
    
    return response.json();
};

const dataURLtoFile = (dataurl: string, filename: string): File => {
    const arr = dataurl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    if (!mimeMatch) throw new Error("Invalid data URL");
    const mime = mimeMatch[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
};


// --- Tipos (Types) ---
type Role = 'ADMIN' | 'OPERATOR' | 'FISCAL';
type View =
  | 'LOGIN'
  | 'ADMIN_DASHBOARD'
  | 'ADMIN_MANAGE_SERVICES'
  | 'ADMIN_MANAGE_LOCATIONS'
  | 'ADMIN_MANAGE_USERS'
  | 'ADMIN_MANAGE_GOALS'
  | 'ADMIN_EDIT_RECORD'
  | 'AUDIT_LOG'
  | 'FISCAL_DASHBOARD'
  | 'REPORTS'
  | 'HISTORY'
  | 'DETAIL'
  | 'OPERATOR_GROUP_SELECT'
  | 'OPERATOR_SERVICE_SELECT'
  | 'OPERATOR_LOCATION_SELECT'
  | 'PHOTO_STEP'
  | 'OPERATOR_SERVICE_IN_PROGRESS'
  | 'CONFIRM_STEP';

interface ServiceDefinition {
    id: string;
    name: string;
    unit: 'm²' | 'm linear';
}

interface UserAssignment {
    contractGroup: string;
    serviceNames: string[];
}

interface User {
  id: string; // From backend will be number, converted to string
  username: string;
  email?: string;
  password?: string;
  role: Role;
  assignments?: UserAssignment[];
}

interface GeolocationCoords {
  latitude: number;
  longitude: number;
}

interface LocationRecord {
  id: string; // From backend will be number, converted to string
  contractGroup: string;
  name: string;
  area: number; // metragem
  coords?: GeolocationCoords;
}

interface ServiceRecord {
  id: string; // From backend will be number, converted to string
  operatorId: string;
  operatorName: string;
  serviceType: string;
  serviceUnit: 'm²' | 'm linear';
  locationId?: string;
  locationName: string;
  contractGroup: string;
  locationArea?: number;
  gpsUsed: boolean;
  startTime: string;
  endTime: string;
  beforePhotos: string[]; // Will now hold URLs
  afterPhotos: string[]; // Will now hold URLs
}

interface Goal {
    id: string;
    contractGroup: string;
    month: string; // YYYY-MM
    targetArea: number;
}

interface AuditLogEntry {
    id: string;
    timestamp: string;
    adminId: string;
    adminUsername: string;
    action: 'UPDATE' | 'DELETE';
    recordId: string;
    details: string;
}

// --- Funções Auxiliares (Helper Functions) ---
const formatDateTime = (isoString: string) => new Date(isoString).toLocaleString('pt-BR');
const calculateDistance = (p1: GeolocationCoords, p2: GeolocationCoords) => {
    if (!p1 || !p2) return Infinity;
    const R = 6371e3; // metres
    const φ1 = p1.latitude * Math.PI / 180;
    const φ2 = p2.latitude * Math.PI / 180;
    const Δφ = (p2.latitude - p1.latitude) * Math.PI / 180;
    const Δλ = (p2.longitude - p1.longitude) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // in metres
};

// --- Componentes ---

const Header: React.FC<{ view: View; currentUser: User | null; onBack?: () => void; onLogout: () => void; }> = ({ view, currentUser, onBack, onLogout }) => {
    const isAdmin = currentUser?.role === 'ADMIN';
    const showBackButton = onBack && view !== 'LOGIN' && view !== 'ADMIN_DASHBOARD' && view !== 'FISCAL_DASHBOARD';
    const showLogoutButton = currentUser;

    const getTitle = () => {
        if (!currentUser) return 'CRB SERVIÇOS';
        
        if (isAdmin) {
            switch(view) {
                case 'ADMIN_DASHBOARD': return 'Painel do Administrador';
                case 'ADMIN_MANAGE_SERVICES': return 'Gerenciar Tipos de Serviço';
                case 'ADMIN_MANAGE_LOCATIONS': return 'Gerenciar Locais';
                case 'ADMIN_MANAGE_USERS': return 'Gerenciar Funcionários';
                case 'ADMIN_MANAGE_GOALS': return 'Metas de Desempenho';
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
            case 'OPERATOR_SERVICE_SELECT': return `Selecione o Serviço`;
            case 'OPERATOR_LOCATION_SELECT': return 'Registro do Serviço';
            case 'OPERATOR_SERVICE_IN_PROGRESS': return 'Serviço em Andamento';
            case 'HISTORY': return 'Meu Histórico';
            case 'DETAIL': return 'Detalhes do Serviço';
            default: return 'Registro de Serviço';
        }
    }
    
    return (
        <header className={isAdmin ? 'admin-header' : ''}>
            {showBackButton && <button className="button button-sm button-secondary header-back-button" onClick={onBack}>&lt; Voltar</button>}
            <h1>{getTitle()}</h1>
            {showLogoutButton && <button className="button button-sm button-danger header-logout-button" onClick={onLogout}>Sair</button>}
        </header>
    );
};

const Loader: React.FC<{ text?: string }> = ({ text = "Carregando..." }) => (
  <div className="loader-container"><div className="spinner"></div><p>{text}</p></div>
);

const CameraView: React.FC<{ onCapture: (dataUrl: string) => void; onCancel: () => void; onFinish: () => void; photoCount: number }> = 
({ onCapture, onCancel, onFinish, photoCount }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);

    useEffect(() => {
        let isMounted = true;
        navigator.mediaDevices.getUserMedia({ video: true })
            .then(mediaStream => {
                if (isMounted) {
                    setStream(mediaStream);
                    if (videoRef.current) videoRef.current.srcObject = mediaStream;
                }
            }).catch(err => {
                console.error("Camera access failed:", err);
                let message = "Acesso à câmera negado.";
                if (err instanceof DOMException) {
                    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
                        message = "Nenhuma câmera encontrada. Conecte uma câmera e tente novamente.";
                    } else if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                        message = "A permissão para acessar a câmera foi negada. Habilite nas configurações do seu navegador.";
                    }
                }
                alert(message);
                onCancel();
            });
        return () => {
            isMounted = false;
            stream?.getTracks().forEach(track => track.stop());
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
        <div className="camera-view">
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
            const { access_token } = await apiFetch('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
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

const AdminDashboard: React.FC<{ 
    onNavigate: (view: View) => void;
}> = ({ onNavigate }) => (
    <div className="admin-dashboard">
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_SERVICES')}>Gerenciar Tipos de Serviço</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_LOCATIONS')}>Gerenciar Locais</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_USERS')}>Gerenciar Funcionários</button>
        <button className="button admin-button" onClick={() => onNavigate('REPORTS')}>Gerador de Relatórios</button>
        <button className="button admin-button" onClick={() => onNavigate('HISTORY')}>Histórico Geral</button>
        <button className="button admin-button" onClick={() => onNavigate('ADMIN_MANAGE_GOALS')}>🎯 Metas de Desempenho</button>
        <button className="button admin-button" onClick={() => onNavigate('AUDIT_LOG')}>📜 Log de Auditoria</button>
    </div>
);

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
    
    // This now relies on the user object fetched from the API having an 'assignments' field.
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
    user: User;
    contractGroup: string;
    services: ServiceDefinition[];
    onSelectService: (service: ServiceDefinition) => void 
}> = ({ user, contractGroup, services, onSelectService }) => {
    
    const assignment = user.assignments?.find(a => a.contractGroup === contractGroup);
    const availableServiceNames = assignment?.serviceNames || [];
    const availableServices = services.filter(s => availableServiceNames.includes(s.name));

    return (
        <div className="card">
            <h2>Escolha o Serviço em "{contractGroup}"</h2>
            <div className="service-selection-list">
                {availableServices.map(service => (
                    <button key={service.id} className="button" onClick={() => onSelectService(service)}>
                        {service.name} ({service.unit})
                    </button>
                ))}
            </div>
        </div>
    );
};

const OperatorLocationSelect: React.FC<{ 
    locations: LocationRecord[]; 
    contractGroup: string; 
    service: ServiceDefinition;
    onLocationSet: (loc: Partial<ServiceRecord>) => void; 
}> = ({ locations, contractGroup, service, onLocationSet }) => {
    const [manualLocationName, setManualLocationName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [gpsLocation, setGpsLocation] = useState<GeolocationCoords | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nearbyLocation, setNearbyLocation] = useState<LocationRecord | null>(null);

    const contractLocations = locations.filter(l => l.contractGroup === contractGroup);

    useEffect(() => {
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const currentCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
                setGpsLocation(currentCoords);
                setError(null);
                const closest = contractLocations
                    .filter(l => l.coords)
                    .map(l => ({ ...l, distance: calculateDistance(currentCoords, l.coords!) }))
                    .filter(l => l.distance < 100) // 100m radius
                    .sort((a, b) => a.distance - b.distance)[0];
                setNearbyLocation(closest || null);
            },
            (err) => setError('Não foi possível obter a localização GPS.'),
            { enableHighAccuracy: true }
        );
        return () => navigator.geolocation.clearWatch(watchId);
    }, [contractLocations]);

    const handleConfirmNearby = () => {
        if(nearbyLocation) {
            onLocationSet({
                locationId: nearbyLocation.id,
                locationName: nearbyLocation.name,
                contractGroup: contractGroup,
                locationArea: nearbyLocation.area,
                gpsUsed: true,
            });
        }
    };

    const handleConfirmNewManual = () => {
        if (manualLocationName.trim()) {
            onLocationSet({
                locationName: manualLocationName.trim(),
                contractGroup: contractGroup,
                gpsUsed: false,
            });
        } else {
            alert('Por favor, digite o nome do novo local.');
        }
    };

    const handleSelectFromList = (loc: LocationRecord) => {
        onLocationSet({
            locationId: loc.id,
            locationName: loc.name,
            contractGroup: loc.contractGroup,
            locationArea: loc.area,
            gpsUsed: false,
        });
    };
    
    const filteredLocations = contractLocations.filter(loc =>
        loc.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="card">
            <h2>Selecione o Local em "{contractGroup}"</h2>
            <p><strong>Serviço:</strong> {service.name} ({service.unit})</p>
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
                <input 
                    type="search" 
                    placeholder="Digite para buscar um local..." 
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)} 
                    style={{marginBottom: '1rem'}}
                />
                <div className="location-selection-list">
                    {filteredLocations.length > 0 ? filteredLocations.map(loc => (
                        <button key={loc.id} className="button button-secondary" onClick={() => handleSelectFromList(loc)}>{loc.name}</button>
                    )) : <p>Nenhum local encontrado com esse nome.</p>}
                </div>
             </div>

             <div className="card-inset">
                <h4>Ou, crie um novo local</h4>
                <input type="text" placeholder="Digite o nome do NOVO local" value={manualLocationName} onChange={e => setManualLocationName(e.target.value)} />
                <button className="button" onClick={handleConfirmNewManual} disabled={!manualLocationName.trim()}>Confirmar Novo Local</button>
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
        const file = event.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const dataUrl = e.target?.result as string;
                if (dataUrl) {
                    setPhotos(p => [...p, dataUrl]);
                }
            };
            reader.readAsDataURL(file);
        }
        if (event.target) {
            event.target.value = '';
        }
    };

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
            <div className="photo-section">
                <h3>Fotos Capturadas ({photos.length})</h3>
                <div className="photo-gallery">
                    {photos.map((p, i) => <img key={i} src={p} alt={`Foto ${i+1}`} className="image-preview" />)}
                </div>
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    style={{ display: 'none' }}
                    accept="image/*"
                    multiple
                />
                <div className="photo-actions">
                    <button className="button" onClick={() => setIsTakingPhoto(true)}>📷 {photos.length > 0 ? 'Tirar Outra Foto' : 'Iniciar Captura'}</button>
                    <button className="button button-secondary" onClick={handleUploadClick}>🖼️ Adicionar Foto do Dispositivo</button>
                </div>
            </div>
            <div style={{display: 'flex', gap: '1rem', marginTop: '1rem'}}>
                <button className="button button-danger" onClick={onCancel}>Cancelar</button>
                <button className="button button-success" onClick={() => onComplete(photos)} disabled={photos.length === 0}>✅ Encerrar Captação</button>
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
            <p><strong>Local:</strong> {recordData.locationName} {recordData.gpsUsed && '📍(GPS)'}</p>
            <p><strong>Data/Hora:</strong> {formatDateTime(new Date().toISOString())}</p>
            {recordData.locationArea ? <p><strong>Metragem:</strong> {recordData.locationArea} {recordData.serviceUnit}</p> : <p><strong>Metragem:</strong> Não informada (novo local)</p>}
            
            <p>O registro e as fotos foram enviados ao servidor.</p>
        </div>
        <div style={{display: 'flex', gap: '1rem'}}>
            <button className="button button-danger" onClick={onCancel}>Cancelar</button>
            <button className="button button-success" onClick={onSave}>✅ Concluir</button>
        </div>
    </div>
);

const HistoryView: React.FC<{ 
    records: ServiceRecord[]; 
    onSelect: (record: ServiceRecord) => void; 
    isAdmin: boolean;
    onEdit?: (record: ServiceRecord) => void;
    onDelete?: (recordId: string) => void;
}> = ({ records, onSelect, isAdmin, onEdit, onDelete }) => (
    <div>
        {records.length === 0 ? <p style={{textAlign: 'center'}}>Nenhum serviço registrado ainda.</p>
        : (
            <ul className="history-list">
                {records.map(record => (
                    <li key={record.id} className="list-item">
                        <div onClick={() => onSelect(record)}>
                            <p><strong>Local:</strong> {record.locationName}, {record.contractGroup} {record.gpsUsed && <span className="gps-indicator">📍</span>}</p>
                            <p><strong>Serviço:</strong> {record.serviceType}</p>
                            <p><strong>Data:</strong> {formatDateTime(record.startTime)}</p>
                            {isAdmin && <p><strong>Operador:</strong> {record.operatorName}</p>}
                            <div className="history-item-photos">
                               {record.beforePhotos.slice(0,2).map((p,i) => <img key={`b-${i}`} src={`${API_BASE}${p}`} />)}
                               {record.afterPhotos.slice(0,2).map((p,i) => <img key={`a-${i}`} src={`${API_BASE}${p}`} />)}
                            </div>
                        </div>
                        {isAdmin && onEdit && onDelete && (
                             <div className="list-item-actions">
                                <button className="button button-sm admin-button" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>Editar</button>
                                <button className="button button-sm button-danger" onClick={(e) => { e.stopPropagation(); onDelete(record.id); }}>Excluir</button>
                            </div>
                        )}
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
            <p><strong>Fim:</strong> {formatDateTime(record.endTime)}</p>
        </div>
        <div className="detail-section card">
            <h3>Fotos "Antes" ({record.beforePhotos.length})</h3>
            <div className="photo-gallery">{record.beforePhotos.map((p,i) => <img key={i} src={`${API_BASE}${p}`} alt={`Antes ${i+1}`} />)}</div>
        </div>
        <div className="detail-section card">
            <h3>Fotos "Depois" ({record.afterPhotos.length})</h3>
            <div className="photo-gallery">{record.afterPhotos.map((p,i) => <img key={i} src={`${API_BASE}${p}`} alt={`Depois ${i+1}`} />)}</div>
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
    
    const allServiceNames = services.map(s => s.name);
    const allContractGroups = [...new Set(records.map(r => r.contractGroup))].sort();

    const handleServiceFilterChange = (service: string, isChecked: boolean) => {
        setSelectedServices(prev => 
            isChecked ? [...prev, service] : prev.filter(s => s !== service)
        );
    };

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
    }

    const handleSelectOne = (id: string, isChecked: boolean) => {
        if(isChecked) setSelectedIds(ids => [...ids, id]);
        else setSelectedIds(ids => ids.filter(i => i !== id));
    }

    const selectedRecords = records.filter(r => selectedIds.includes(r.id));
    const totalArea = selectedRecords.reduce((sum, r) => sum + (r.locationArea || 0), 0);

    const handleExportExcel = async () => {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Relatório de Serviços');
        sheet.columns = [
            { header: 'Contrato/Cidade', key: 'group', width: 25 },
            { header: 'Data', key: 'date', width: 20 },
            { header: 'Serviço', key: 'service', width: 20 },
            { header: 'Local', key: 'location', width: 30 },
            { header: 'Medição', key: 'area', width: 15 },
            { header: 'Unidade', key: 'unit', width: 10 },
        ];
        selectedRecords.forEach(r => {
            sheet.addRow({
                group: r.contractGroup,
                date: formatDateTime(r.startTime),
                service: r.serviceType,
                location: r.locationName,
                area: r.locationArea || 'N/A',
                unit: r.serviceUnit
            });
        });
        sheet.addRow({});
        const totalRow = sheet.addRow({ location: 'Total de Medição (somado)', area: totalArea });
        totalRow.font = { bold: true };

        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `relatorio_crb_${new Date().toISOString().split('T')[0]}.xlsx`;
        link.click();
    };

    const handleExportPdf = async () => {
        if (!printableRef.current) return;
        const doc = new jsPDF('p', 'mm', 'a4');
        const pages = printableRef.current.querySelectorAll('.printable-report-page');

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i] as HTMLElement;
            const canvas = await html2canvas(page, { scale: 2 });
            const imgData = canvas.toDataURL('image/png');
            const imgProps= doc.getImageProperties(imgData);
            const pdfWidth = doc.internal.pageSize.getWidth();
            const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
            
            if (i > 0) doc.addPage();
            doc.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        }
        doc.save(`relatorio_fotos_crb_${new Date().toISOString().split('T')[0]}.pdf`);
    };

    if (!reportType) {
        return (
            <div className="card">
                <h2>Selecione o Tipo de Relatório</h2>
                <div className="button-group" style={{flexDirection: 'column', gap: '1rem'}}>
                    <button className="button" onClick={() => setReportType('excel')}>📊 Relatório Planilha de Excel</button>
                    <button className="button button-secondary" onClick={() => setReportType('photos')}>🖼️ Relatório de Fotografias (PDF)</button>
                </div>
            </div>
        )
    }

    return (
        <div>
            <div className="card report-filters">
                <div className="form-group">
                    <label htmlFor="start-date">Data de Início</label>
                    <input id="start-date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div className="form-group">
                    <label htmlFor="end-date">Data Final</label>
                    <input id="end-date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
                 <div className="form-group">
                    <label htmlFor="group-filter">Contrato/Cidade</label>
                    <select id="group-filter" value={selectedContractGroup} onChange={e => setSelectedContractGroup(e.target.value)}>
                        <option value="">Todos</option>
                        {allContractGroups.map(group => (
                            <option key={group} value={group}>{group}</option>
                        ))}
                    </select>
                </div>
                <fieldset className="form-group-full">
                    <legend>Filtrar por Serviço</legend>
                    <div className="checkbox-group">
                        {allServiceNames.map(service => (
                            <div key={service} className="checkbox-item">
                                <input type="checkbox" id={`service-${service}`} checked={selectedServices.includes(service)} onChange={e => handleServiceFilterChange(service, e.target.checked)} />
                                <label htmlFor={`service-${service}`}>{service}</label>
                            </div>
                        ))}
                    </div>
                </fieldset>
            </div>

            <div className="report-list">
                {filteredRecords.length > 0 && (
                     <div className="report-item">
                        <input type="checkbox" onChange={handleSelectAll} checked={selectedIds.length === filteredRecords.length && filteredRecords.length > 0} />
                        <div className="report-item-info"><strong>Selecionar Todos</strong></div>
                    </div>
                )}
                {filteredRecords.map(r => (
                    <div key={r.id} className="report-item">
                        <input type="checkbox" checked={selectedIds.includes(r.id)} onChange={e => handleSelectOne(r.id, e.target.checked)} />
                        <div className="report-item-info">
                            <p><strong>{r.locationName}, {r.contractGroup}</strong></p>
                            <p>{r.serviceType} - {formatDateTime(r.startTime)} - {r.locationArea || 0} {r.serviceUnit}</p>
                        </div>
                    </div>
                ))}
            </div>

            {selectedIds.length > 0 && (
                <div className="report-summary card">
                    <h3>Resumo da Exportação</h3>
                    <p>{selectedRecords.length} registro(s) selecionado(s).</p>
                    <p>Total de medição (unidades somadas): <strong>{totalArea.toLocaleString('pt-BR')}</strong></p>
                    <div className="button-group">
                        {reportType === 'excel' && <button className="button" onClick={handleExportExcel}>📊 Exportar Excel</button>}
                        {reportType === 'photos' && <button className="button button-secondary" onClick={handleExportPdf}>🖼️ Exportar PDF c/ Fotos</button>}
                    </div>
                </div>
            )}
            
            <div className="printable-report" ref={printableRef}>
                {selectedRecords.map(r => (
                    <div key={r.id} className="printable-report-page">
                        <div className="printable-page-header">
                            <h2>Relatório de Serviço - CRB Serviços</h2>
                            <p><strong>Contrato/Cidade:</strong> {r.contractGroup}</p>
                            <p><strong>Local:</strong> {r.locationName}</p>
                            <p><strong>Serviço:</strong> {r.serviceType}</p>
                            <p><strong>Data:</strong> {formatDateTime(r.startTime)}</p>
                            <p><strong>Medição:</strong> {r.locationArea ? `${r.locationArea.toLocaleString('pt-BR')} ${r.serviceUnit}` : 'Não informada'}</p>
                        </div>
                        <h3>Fotos "Antes"</h3>
                        <div className="printable-report-gallery">
                            {r.beforePhotos.map((p, i) => (
                                <div key={`before-${i}`} className="photo-item-container">
                                    <img src={`${API_BASE}${p}`} alt={`Foto Antes ${i + 1}`} />
                                    <p className="caption">Antes {i + 1}</p>
                                </div>
                            ))}
                        </div>
                        <h3>Fotos "Depois"</h3>
                        <div className="printable-report-gallery">
                            {r.afterPhotos.map((p, i) => (
                                <div key={`after-${i}`} className="photo-item-container">
                                    <img src={`${API_BASE}${p}`} alt={`Foto Depois ${i + 1}`} />
                                    <p className="caption">Depois {i + 1}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

const ManageLocationsView: React.FC<{ 
    locations: LocationRecord[]; 
    onUpdate: () => Promise<void>;
}> = ({ locations, onUpdate }) => {
    const [selectedGroup, setSelectedGroup] = useState('');
    const [name, setName] = useState('');
    const [area, setArea] = useState('');
    const [coords, setCoords] = useState<Partial<GeolocationCoords> | null>(null);
    const [isFetchingCoords, setIsFetchingCoords] = useState(false);
    const [editingId, setEditingId] = useState<string|null>(null);

    const allGroups = [...new Set(locations.map(l => l.contractGroup))].sort();

    const resetForm = () => {
        setName('');
        setArea('');
        setCoords(null);
        setEditingId(null);
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

    const handleSave = async () => {
        if (!selectedGroup) {
            alert('Digite o nome do Contrato/Cidade.');
            return;
        }
        if (!name || !area || isNaN(parseFloat(area))) {
            alert('Preencha todos os campos corretamente.');
            return;
        }

        const payload = {
            city: selectedGroup.trim(),
            name,
            area: parseFloat(area),
            lat: coords?.latitude,
            lng: coords?.longitude,
        };

        try {
            if (editingId) {
                await apiFetch(`/api/locations/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/locations', { method: 'POST', body: JSON.stringify(payload) });
            }
            await onUpdate();
            resetForm();
        } catch (error) {
            alert('Falha ao salvar local. Tente novamente.');
            console.error(error);
        }
    };

    const handleEdit = (loc: LocationRecord) => {
        setEditingId(loc.id);
        setName(loc.name);
        setArea(String(loc.area));
        setCoords(loc.coords || null);
        setSelectedGroup(loc.contractGroup);
    };

    const handleDelete = async (id: string) => {
        if(window.confirm('Excluir este local?')) {
            try {
                await apiFetch(`/api/locations/${id}`, { method: 'DELETE' });
                await onUpdate();
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
                <input 
                    list="contract-groups" 
                    placeholder="Digite ou selecione um Contrato/Cidade" 
                    value={selectedGroup} 
                    onChange={e => {setSelectedGroup(e.target.value); resetForm();}}
                />
                <datalist id="contract-groups">
                    {allGroups.map(g => <option key={g} value={g} />)}
                </datalist>
            </div>
            
            {selectedGroup && (
                <>
                <div className="form-container card">
                    <h3>{editingId ? 'Editando Local' : 'Adicionar Novo Local'} em "{selectedGroup}"</h3>
                    <input type="text" placeholder="Nome do Local" value={name} onChange={e => setName(e.target.value)} />
                    <input type="number" placeholder="Metragem (use a unidade do serviço)" value={area} onChange={e => setArea(e.target.value)} />
                    
                    <div className="form-group" style={{marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '1rem'}}>
                         <label>Coordenadas GPS (Opcional)</label>
                         <p style={{fontSize: '0.8rem', color: '#666', margin: '0.25rem 0'}}>Preencha manualmente ou clique no botão para capturar as coordenadas GPS atuais.</p>
                         <div className="coord-inputs">
                            <input type="number" step="any" placeholder="Latitude" value={coords?.latitude ?? ''} onChange={e => handleCoordChange('latitude', e.target.value)} />
                            <input type="number" step="any" placeholder="Longitude" value={coords?.longitude ?? ''} onChange={e => handleCoordChange('longitude', e.target.value)} />
                         </div>
                         <button className="button button-secondary" onClick={handleGetCoordinates} disabled={isFetchingCoords}>
                            {isFetchingCoords ? 'Obtendo GPS...' : '📍 Obter Coordenadas GPS Atuais'}
                        </button>
                    </div>

                    <button className="button admin-button" onClick={handleSave}>{editingId ? 'Salvar Alterações' : 'Adicionar Local'}</button>
                    {editingId && <button className="button button-secondary" onClick={resetForm}>Cancelar Edição</button>}
                </div>
                <ul className="location-list">
                    {filteredLocations.sort((a,b) => a.name.localeCompare(b.name)).map(loc => (
                        <li key={loc.id} className="card list-item">
                            <div className="list-item-header">
                                <h3>{loc.name}</h3>
                                <div>
                                    <button className="button button-sm admin-button" onClick={() => handleEdit(loc)}>Editar</button>
                                    <button className="button button-sm button-danger" onClick={() => handleDelete(loc.id)}>Excluir</button>
                                </div>
                            </div>
                            <p><strong>Metragem Base:</strong> {loc.area}</p>
                            {loc.coords && <p><strong>GPS:</strong> Sim <span className="gps-indicator">📍</span></p>}
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
}> = ({ users, onUsersUpdate }) => {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState<Role>('OPERATOR');
    const [assignments, setAssignments] = useState<UserAssignment[]>([]);
    const [editingId, setEditingId] = useState<string|null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const resetForm = () => {
        setUsername('');
        setPassword('');
        setEmail('');
        setRole('OPERATOR');
        setAssignments([]);
        setEditingId(null);
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

        const payload: { name: string; email: string; role: Role; password?: string } = {
            name: username,
            email,
            role,
        };
        // Only include the password if it's being set or changed
        if (password) {
            payload.password = password;
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
                    <option value="ADMIN">Administrador</option>
                    <option value="OPERATOR">Operador</option>
                    <option value="FISCAL">Fiscalização</option>
                </select>
                
                <p style={{marginTop: '1rem', fontSize: '0.9rem'}}>Atenção: A atribuição de contratos/serviços a usuários ainda é uma funcionalidade em desenvolvimento no backend.</p>

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

const ManageGoalsView: React.FC<{
    goals: Goal[];
    onUpdate: () => Promise<void>;
    records: ServiceRecord[];
    locations: LocationRecord[];
}> = ({ goals, onUpdate, records, locations }) => {
    const [contractGroup, setContractGroup] = useState('');
    const [month, setMonth] = useState(new Date().toISOString().substring(0, 7)); // YYYY-MM
    const [targetArea, setTargetArea] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    
    const allGroups = [...new Set(locations.map(l => l.contractGroup).concat(records.map(r => r.contractGroup)))].sort();

    const resetForm = () => {
        setContractGroup('');
        setMonth(new Date().toISOString().substring(0, 7));
        setTargetArea('');
        setEditingId(null);
    };

    const handleSave = async () => {
        if (!contractGroup || !month || !targetArea || isNaN(parseFloat(targetArea))) {
            alert('Preencha todos os campos corretamente.');
            return;
        }
        setIsLoading(true);
        const payload = {
            contractGroup,
            month,
            targetArea: parseFloat(targetArea),
        };
        try {
            if (editingId) {
                await apiFetch(`/api/goals/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/goals', { method: 'POST', body: JSON.stringify(payload) });
            }
            resetForm();
            await onUpdate();
        } catch (e) {
            alert('Falha ao salvar a meta.');
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleEdit = (goal: Goal) => {
        setEditingId(goal.id);
        setContractGroup(goal.contractGroup);
        setMonth(goal.month);
        setTargetArea(String(goal.targetArea));
    };

    const handleDelete = async (id: string) => {
        if (window.confirm('Excluir esta meta?')) {
            setIsLoading(true);
            try {
                await apiFetch(`/api/goals/${id}`, { method: 'DELETE' });
                await onUpdate();
            } catch (e) {
                alert('Falha ao excluir a meta.');
                console.error(e);
            } finally {
                setIsLoading(false);
            }
        }
    };

    return (
        <div>
            <div className="form-container card">
                <h3>{editingId ? 'Editando Meta' : 'Adicionar Nova Meta'}</h3>
                 <input 
                    list="goal-contract-groups" 
                    placeholder="Digite ou selecione um Contrato/Cidade" 
                    value={contractGroup} 
                    onChange={e => setContractGroup(e.target.value)}
                />
                <datalist id="goal-contract-groups">
                    {allGroups.map(g => <option key={g} value={g} />)}
                </datalist>
                <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
                <input type="number" placeholder="Meta de Medição (m² ou m linear)" value={targetArea} onChange={e => setTargetArea(e.target.value)} />
                <button className="button admin-button" onClick={handleSave} disabled={isLoading}>
                    {isLoading ? 'Salvando...' : (editingId ? 'Salvar Alterações' : 'Adicionar Meta')}
                </button>
                {editingId && <button className="button button-secondary" onClick={resetForm} disabled={isLoading}>Cancelar Edição</button>}
            </div>

            <ul className="goal-list">
                {[...goals]
                    .filter(goal => goal && typeof goal.month === 'string' && typeof goal.contractGroup === 'string')
                    .sort((a, b) => b.month.localeCompare(a.month) || a.contractGroup.localeCompare(b.contractGroup))
                    .map(goal => {
                        const realizedArea = records
                            .filter(r => r && r.contractGroup === goal.contractGroup && typeof r.startTime === 'string' && r.startTime.startsWith(goal.month))
                            .reduce((sum, r) => sum + (r.locationArea || 0), 0);
                    
                        const percentage = goal.targetArea > 0 ? (realizedArea / goal.targetArea) * 100 : 0;
                        const remainingArea = Math.max(0, goal.targetArea - realizedArea);

                        return (
                            <li key={goal.id} className="card list-item progress-card">
                                 <div className="list-item-header">
                                    <h3>{goal.contractGroup} - {goal.month}</h3>
                                    <div>
                                        <button className="button button-sm admin-button" onClick={() => handleEdit(goal)}>Editar</button>
                                        <button className="button button-sm button-danger" onClick={() => handleDelete(goal.id)}>Excluir</button>
                                    </div>
                                </div>
                                <div className="progress-info">
                                    <span>Realizado: {realizedArea.toLocaleString('pt-BR')} / {goal.targetArea.toLocaleString('pt-BR')}</span>
                                    <span>{percentage.toFixed(1)}%</span>
                                </div>
                                <div className="progress-bar-container">
                                    <div className="progress-bar" style={{ width: `${Math.min(percentage, 100)}%` }}></div>
                                </div>
                                 <p className="remaining-info">Faltam: {remainingArea.toLocaleString('pt-BR')} para atingir a meta.</p>
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
                <p><strong>Local:</strong> {service.locationName}</p>
                <p><strong>Início:</strong> {service.startTime ? formatDateTime(service.startTime) : 'N/A'}</p>
            </div>
            <p>O registro inicial e as fotos "Antes" foram salvos no servidor. Complete o serviço no local.</p>
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
    services: ServiceDefinition[];
}> = ({ record, onSave, onCancel, services }) => {
    const [formData, setFormData] = useState<ServiceRecord>(record);
    
    // This view is now mostly read-only as the backend does not support record updates.
    // The form elements are disabled.

    return (
        <div className="card edit-form-container">
             <div className="form-group">
                <label>Nome do Local</label>
                <input type="text" value={formData.locationName} disabled />
            </div>
            <div className="form-group">
                <label>Tipo de Serviço</label>
                <input type="text" value={formData.serviceType} disabled />
            </div>
             <div className="form-group">
                <label>Medição ({formData.serviceUnit})</label>
                <input type="number" value={formData.locationArea || ''} disabled />
            </div>
            
            <div className="form-group">
                <h4>Fotos "Antes" ({formData.beforePhotos.length})</h4>
                <div className="edit-photo-gallery">
                    {formData.beforePhotos.map((p, i) => (
                        <div key={i} className="edit-photo-item">
                            <img src={`${API_BASE}${p}`} alt={`Antes ${i+1}`} />
                        </div>
                    ))}
                </div>
            </div>

            <div className="form-group">
                <h4>Fotos "Depois" ({formData.afterPhotos.length})</h4>
                <div className="edit-photo-gallery">
                    {formData.afterPhotos.map((p, i) => (
                        <div key={i} className="edit-photo-item">
                            <img src={`${API_BASE}${p}`} alt={`Depois ${i+1}`} />
                        </div>
                    ))}
                </div>
            </div>
            
            <p className="text-danger" style={{marginTop: '1rem'}}>A edição de registros não é suportada pelo backend no momento. Esta tela é somente para visualização.</p>

            <div className="button-group">
                <button className="button button-secondary" onClick={onCancel}>Voltar</button>
                <button className="button button-success" onClick={() => onSave(formData)} disabled>Salvar Alterações</button>
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
                <h2>Registros de Alterações</h2>
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
    onUpdate: () => Promise<void>;
}> = ({ services, onUpdate }) => {
    const [name, setName] = useState('');
    const [unit, setUnit] = useState<'m²' | 'm linear'>('m²');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const resetForm = () => {
        setName('');
        setUnit('m²');
        setEditingId(null);
    };

    const handleSave = async () => {
        if (!name.trim()) {
            alert('O nome do serviço é obrigatório.');
            return;
        }
        setIsLoading(true);
        const payload = { name: name.trim(), unit };
        try {
            if (editingId) {
                await apiFetch(`/api/services/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
            } else {
                await apiFetch('/api/services', { method: 'POST', body: JSON.stringify(payload) });
            }
            resetForm();
            await onUpdate();
        } catch (e) {
            alert('Falha ao salvar o serviço.');
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleEdit = (service: ServiceDefinition) => {
        setEditingId(service.id);
        setName(service.name);
        setUnit(service.unit);
    };

    const handleDelete = async (id: string) => {
        if (window.confirm('Excluir este tipo de serviço? Isso pode afetar usuários e registros existentes.')) {
            setIsLoading(true);
            try {
                await apiFetch(`/api/services/${id}`, { method: 'DELETE' });
                await onUpdate();
            } catch (e) {
                alert('Falha ao excluir o serviço.');
                console.error(e);
            } finally {
                setIsLoading(false);
            }
        }
    };

    return (
        <div>
            <div className="form-container card">
                <h3>{editingId ? 'Editando Tipo de Serviço' : 'Adicionar Novo Tipo de Serviço'}</h3>
                <input type="text" placeholder="Nome do Serviço" value={name} onChange={e => setName(e.target.value)} />
                <select value={unit} onChange={e => setUnit(e.target.value as any)}>
                    <option value="m²">m² (Metros Quadrados)</option>
                    <option value="m linear">m linear (Metros Lineares)</option>
                </select>
                <button className="button admin-button" onClick={handleSave} disabled={isLoading}>
                    {isLoading ? 'Salvando...' : (editingId ? 'Salvar Alterações' : 'Adicionar Serviço')}
                </button>
                {editingId && <button className="button button-secondary" onClick={resetForm} disabled={isLoading}>Cancelar Edição</button>}
            </div>
            <ul className="location-list">
                {services.sort((a,b) => a.name.localeCompare(b.name)).map(s => (
                    <li key={s.id} className="card list-item">
                        <div className="list-item-info">
                           <p><strong>{s.name}</strong></p>
                           <p>Unidade: {s.unit}</p>
                        </div>
                        <div className="list-item-actions">
                            <button className="button button-sm admin-button" onClick={() => handleEdit(s)}>Editar</button>
                            <button className="button button-sm button-danger" onClick={() => handleDelete(s.id)}>Excluir</button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
};

// --- Componente Principal ---
const App = () => {
  const [view, setView] = useState<View>('LOGIN');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  
  // Data from API
  const [users, setUsers] = useState<User[]>([]);
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [records, setRecords] = useState<ServiceRecord[]>([]);
  const [services, setServices] = useState<ServiceDefinition[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  
  // Local transient state
  const [currentService, setCurrentService] = useState<Partial<ServiceRecord>>({});
  const [selectedRecord, setSelectedRecord] = useState<ServiceRecord | null>(null);
  const [selectedContractGroup, setSelectedContractGroup] = useState<string | null>(null);
  const [history, setHistory] = useState<View[]>([]);
  const [isLoading, setIsLoading] = useState<string | null>(null);

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
      localStorage.removeItem('crbCurrentUser'); // Clean up old local storage
      localStorage.removeItem('crbCurrentService');
      setHistory([]);
      setSelectedContractGroup(null);
      setCurrentService({});
      setLocations([]);
      setRecords([]);
      setUsers([]);
      setServices([]);
      setGoals([]);
      setAuditLog([]);
      navigate('LOGIN', true);
  }

  const fetchData = async () => {
    if (!currentUser) return;
    setIsLoading('Carregando dados...');
    try {
        if (currentUser.role === 'ADMIN') {
            const [locs, recs, usrs, srvs, gls, adt] = await Promise.all([
                apiFetch('/api/locations'),
                apiFetch('/api/records'),
                apiFetch('/api/users'),
                apiFetch('/api/services'),
                apiFetch('/api/goals'),
                apiFetch('/api/audit-log')
            ]);
            setLocations(locs.map((l: any) => ({id: String(l.id), contractGroup: l.city, name: l.name, area: l.area || 0, coords: (l.lat!=null && l.lng!=null) ? { latitude: l.lat, longitude: l.lng } : undefined })));
            setRecords(recs.map((r: any) => ({...r, id: String(r.id), operatorId: String(r.operatorId) })));
            setUsers(usrs.map((u: any) => ({id: String(u.id), username: u.name, email: u.email, role: u.role, assignments: u.assignments || [] })));
            setServices(srvs.map((s: any) => ({...s, id: String(s.id)})));
            setGoals(gls.map((g: any) => ({...g, id: String(g.id)})));
            setAuditLog(adt.map((a: any) => ({...a, id: String(a.id)})));
        } else if (currentUser.role === 'FISCAL') {
            const [recs, srvs] = await Promise.all([
                 apiFetch('/api/records'),
                 apiFetch('/api/services')
            ]);
            const fiscalGroups = currentUser.assignments?.map(a => a.contractGroup) || [];
            setRecords(
                recs.filter((r: any) => fiscalGroups.includes(r.contractGroup))
                .map((r: any) => ({...r, id: String(r.id), operatorId: String(r.operatorId) }))
            );
            setServices(srvs.map((s: any) => ({...s, id: String(s.id)})));
        } else if (currentUser.role === 'OPERATOR') {
             const [locs, recs, srvs] = await Promise.all([
                apiFetch('/api/locations'),
                apiFetch(`/api/records?operatorId=${currentUser.id}`),
                apiFetch('/api/services')
             ]);
             setLocations(locs.map((l: any) => ({id: String(l.id), contractGroup: l.city, name: l.name, area: l.area || 0, coords: (l.lat!=null && l.lng!=null) ? { latitude: l.lat, longitude: l.lng } : undefined })));
             setRecords(recs.map((r: any) => ({...r, id: String(r.id), operatorId: String(r.operatorId) })));
             setServices(srvs.map((s: any) => ({...s, id: String(s.id)})));
        }
    } catch (error) {
        console.error("Failed to fetch data", error);
        alert("Não foi possível carregar os dados do servidor.");
        if (error instanceof Error && error.message.includes('401')) { // Unauthorized
            handleLogout();
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (currentUser) {
        fetchData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);


  const resetService = () => {
      setCurrentService({});
      setSelectedContractGroup(null);
      redirectUser(currentUser!);
  }

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    redirectUser(user);
  };

  const handleGroupSelect = (group: string) => {
      setSelectedContractGroup(group);
      navigate('OPERATOR_SERVICE_SELECT');
  }

  const handleServiceSelect = (service: ServiceDefinition) => {
    setCurrentService({ serviceType: service.name, serviceUnit: service.unit, contractGroup: selectedContractGroup });
    navigate('OPERATOR_LOCATION_SELECT');
  };

  const handleLocationSet = (locData: Partial<ServiceRecord>) => {
      setCurrentService(s => ({...s, ...locData}));
      navigate('PHOTO_STEP');
  };

  const handleBeforePhotos = async (photos: string[]) => {
      if (!currentUser || !currentService.serviceType || !currentService.contractGroup) {
          alert("Erro: Dados do serviço incompletos.");
          return;
      }
      setIsLoading("Criando registro e enviando fotos 'Antes'...");
      try {
          const recordPayload = {
              operatorId: currentUser.id,
              serviceType: currentService.serviceType,
              serviceUnit: currentService.serviceUnit,
              locationId: currentService.locationId,
              locationName: currentService.locationName,
              contractGroup: currentService.contractGroup,
              locationArea: currentService.locationArea,
              gpsUsed: !!currentService.gpsUsed,
              startTime: new Date().toISOString()
          };
          const newRecord = await apiFetch('/api/records', { method: 'POST', body: JSON.stringify(recordPayload) });
          
          const photoFiles = photos.map((dataUrl, i) => dataURLtoFile(dataUrl, `before_${i}.jpg`));
          if (photoFiles.length > 0) {
              const formData = new FormData();
              formData.append('phase', 'BEFORE');
              photoFiles.forEach(file => formData.append('files', file));
              await apiFetch(`/api/records/${newRecord.id}/photos`, { method: 'POST', body: formData });
          }

          setCurrentService(s => ({...s, id: String(newRecord.id), startTime: newRecord.startTime }));
          navigate('OPERATOR_SERVICE_IN_PROGRESS');
      } catch(e) {
          alert("Falha ao salvar fotos 'Antes'. Tente novamente.");
          console.error(e);
      } finally {
          setIsLoading(null);
      }
  };

  const handleAfterPhotos = async (photos: string[]) => {
      if (!currentService.id) {
          alert("Erro: ID do registro não encontrado.");
          return;
      }
      setIsLoading("Enviando fotos 'Depois'...");
      try {
          const photoFiles = photos.map((dataUrl, i) => dataURLtoFile(dataUrl, `after_${i}.jpg`));
          if (photoFiles.length > 0) {
              const formData = new FormData();
              formData.append('phase', 'AFTER');
              photoFiles.forEach(file => formData.append('files', file));
              await apiFetch(`/api/records/${currentService.id}/photos`, { method: 'POST', body: formData });
          }
          
          const updatedRecord = await apiFetch(`/api/records/${currentService.id}`, { method: 'PUT', body: JSON.stringify({ endTime: new Date().toISOString() }) });
          
          setCurrentService(s => ({...s, endTime: updatedRecord.endTime }));
          navigate('CONFIRM_STEP');
      } catch(e) {
          alert("Falha ao salvar fotos 'Depois'. Tente novamente.");
          console.error(e);
      } finally {
          setIsLoading(null);
      }
  };

  const handleSave = () => {
    alert("Registro salvo com sucesso no servidor.");
    resetService();
  };

  const handleSelectRecord = async (record: ServiceRecord) => {
    setIsLoading("Carregando detalhes...");
    try {
        const detailedRecord = await apiFetch(`/api/records/${record.id}`);
        setSelectedRecord(detailedRecord);
        navigate('DETAIL');
    } catch (e) {
        alert('Não foi possível carregar os detalhes do registro.');
    } finally {
        setIsLoading(null);
    }
  }

  const handleEditRecord = (record: ServiceRecord) => {
      setSelectedRecord(record);
      navigate('ADMIN_EDIT_RECORD');
  };

  const handleUpdateRecord = (updatedRecord: ServiceRecord) => {
    alert("A edição de registros não está implementada no backend.");
  };

  const handleDeleteRecord = async (recordId: string) => {
      if (!currentUser || currentUser.role !== 'ADMIN') return;
      
      const recordToDelete = records.find(r => r.id === recordId);
      if (!recordToDelete) return;

      if (window.confirm(`Tem certeza que deseja excluir o registro do local "${recordToDelete.locationName}"? Esta ação não pode ser desfeita.`)) {
          setIsLoading("Excluindo registro...");
          try {
              await apiFetch(`/api/records/${recordId}`, { method: 'DELETE' });
              // The backend creates the audit log entry upon deletion.
              // Refetching data will update both the records list and the audit log.
              await fetchData();
              alert("Registro excluído com sucesso.");
          } catch(e) {
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
    
    switch(currentUser.role) {
        case 'ADMIN':
            switch(view) {
                case 'ADMIN_DASHBOARD': return <AdminDashboard onNavigate={navigate} />;
                case 'ADMIN_MANAGE_SERVICES': return <ManageServicesView services={services} onUpdate={fetchData} />;
                case 'ADMIN_MANAGE_LOCATIONS': return <ManageLocationsView locations={locations} onUpdate={fetchData} />;
                case 'ADMIN_MANAGE_USERS': return <ManageUsersView users={users} onUsersUpdate={fetchData} services={services} />;
                case 'ADMIN_MANAGE_GOALS': return <ManageGoalsView goals={goals} onUpdate={fetchData} records={records} locations={locations} />;
                case 'REPORTS': return <ReportsView records={records} services={services} />;
                case 'HISTORY': return <HistoryView records={records} onSelect={handleSelectRecord} isAdmin={true} onEdit={handleEditRecord} onDelete={handleDeleteRecord} />;
                case 'DETAIL': return selectedRecord ? <DetailView record={selectedRecord} /> : <p>Registro não encontrado.</p>;
                case 'ADMIN_EDIT_RECORD': return selectedRecord ? <AdminEditRecordView record={selectedRecord} onSave={handleUpdateRecord} onCancel={handleBack} services={services} /> : <p>Nenhum registro selecionado para edição.</p>;
                case 'AUDIT_LOG': return <AuditLogView log={auditLog} />;
                default: return <AdminDashboard onNavigate={navigate} />;
            }
        
        case 'FISCAL':
            const fiscalGroups = currentUser.assignments?.map(a => a.contractGroup) || [];
            const fiscalRecords = records.filter(r => fiscalGroups.includes(r.contractGroup));
            switch(view) {
                case 'FISCAL_DASHBOARD': return <FiscalDashboard onNavigate={navigate} />;
                case 'REPORTS': return <ReportsView records={fiscalRecords} services={services} />;
                case 'HISTORY': return <HistoryView records={fiscalRecords} onSelect={handleSelectRecord} isAdmin={false} />;
                case 'DETAIL':
                    const canView = selectedRecord && fiscalGroups.includes(selectedRecord.contractGroup);
                    return canView ? <DetailView record={selectedRecord} /> : <p>Registro não encontrado ou acesso não permitido.</p>;
                default: return <FiscalDashboard onNavigate={navigate} />;
            }

        case 'OPERATOR':
            switch(view) {
                case 'OPERATOR_GROUP_SELECT': return <OperatorGroupSelect user={currentUser} onSelectGroup={handleGroupSelect} />;
                case 'OPERATOR_SERVICE_SELECT': return selectedContractGroup ? <OperatorServiceSelect user={currentUser} contractGroup={selectedContractGroup} services={services} onSelectService={handleServiceSelect} /> : null;
                case 'OPERATOR_LOCATION_SELECT': return selectedContractGroup && currentService.serviceType ? <OperatorLocationSelect locations={locations} contractGroup={selectedContractGroup} service={{id: '', name: currentService.serviceType, unit: currentService.serviceUnit!}} onLocationSet={handleLocationSet} /> : null;
                case 'OPERATOR_SERVICE_IN_PROGRESS': return <ServiceInProgressView service={currentService} onFinish={() => navigate('PHOTO_STEP')} />;
                case 'PHOTO_STEP': 
                    if(!currentService.id) {
                        return <PhotoStep phase="BEFORE" onComplete={handleBeforePhotos} onCancel={resetService} />;
                    }
                    return <PhotoStep phase="AFTER" onComplete={handleAfterPhotos} onCancel={resetService} />;
                case 'CONFIRM_STEP': return <ConfirmStep recordData={currentService} onSave={handleSave} onCancel={resetService} />;
                case 'HISTORY': 
                    const operatorRecords = records.filter(r => r.operatorId === currentUser.id);
                    return <HistoryView records={operatorRecords} onSelect={handleSelectRecord} isAdmin={false} />;
                case 'DETAIL': return selectedRecord ? <DetailView record={selectedRecord} /> : <p>Registro não encontrado.</p>;
                default: return <OperatorGroupSelect user={currentUser} onSelectGroup={handleGroupSelect} />;
            }
        
        default:
             handleLogout();
             return null;
    }
  };

  return (
    <div className="app-container">
      {isLoading && (
          <div className="loader-overlay">
              <div className="spinner"></div>
              <p>{isLoading}</p>
          </div>
      )}
      <Header view={view} currentUser={currentUser} onBack={view !== 'LOGIN' && view !== 'ADMIN_DASHBOARD' && view !== 'FISCAL_DASHBOARD' ? handleBack : undefined} onLogout={handleLogout} />
      <main>{renderView()}</main>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
