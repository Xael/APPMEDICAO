import { jsx, jsxs } from 'react/jsx-runtime';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// --- API Client & Helpers ---

// IMPORTANT: Configure your API URL.
// In Vercel, set an environment variable named VITE_API_BASE.
// For local development, create a .env.local file with: VITE_API_BASE=http://localhost:8000
const API_BASE = ''; // This should be configured via environment variables.

let API_TOKEN = localStorage.getItem('crbApiToken');

const setApiToken = (token) => {
    API_TOKEN = token;
    if (token) {
        localStorage.setItem('crbApiToken', token);
    } else {
        localStorage.removeItem('crbApiToken');
    }
};

const apiFetch = async (path, options = {}) => {
    if (!API_BASE) {
        alert('A URL da API (VITE_API_BASE) não está configurada. Verifique seu arquivo .env.local ou as configurações de ambiente na Vercel.');
        throw new Error('API_BASE URL is not configured.');
    }
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

const dataURLtoFile = (dataurl, filename) => {
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

// --- Dados Padrão (Default Data) ---
const DEFAULT_SERVICES = [
    { id: 'service-1', name: 'Roçagem', unit: 'm²' },
    { id: 'service-2', name: 'Pintura de Guia', unit: 'm linear' },
    { id: 'service-3', name: 'Varreção', unit: 'm²' },
    { id: 'service-4', name: 'Capinagem', unit: 'm²' },
    { id: 'service-5', name: 'Roçagem em Escolas', unit: 'm²' },
];


// --- Funções Auxiliares (Helper Functions) ---
const formatDateTime = (isoString) => new Date(isoString).toLocaleString('pt-BR');
const calculateDistance = (p1, p2) => {
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

const generateChangeLogDetails = (original, updated) => {
    const changes = [];
    if (original.locationName !== updated.locationName) {
        changes.push(`Nome do Local de "${original.locationName}" para "${updated.locationName}"`);
    }
    if (original.serviceType !== updated.serviceType) {
        changes.push(`Tipo de Serviço de "${original.serviceType}" para "${updated.serviceType}"`);
    }
    if (original.locationArea !== updated.locationArea) {
        changes.push(`Metragem de "${original.locationArea || 0}" para "${updated.locationArea || 0}"`);
    }

    const beforePhotosAdded = updated.beforePhotos.filter(p => !original.beforePhotos.includes(p)).length;
    const beforePhotosRemoved = original.beforePhotos.filter(p => !updated.beforePhotos.includes(p)).length;
    if (beforePhotosAdded > 0 || beforePhotosRemoved > 0) {
        let photoChange = 'Fotos "Antes": ';
        if (beforePhotosAdded > 0) photoChange += `adicionou ${beforePhotosAdded}`;
        if (beforePhotosAdded > 0 && beforePhotosRemoved > 0) photoChange += ', ';
        if (beforePhotosRemoved > 0) photoChange += `removeu ${beforePhotosRemoved}`;
        changes.push(photoChange);
    }
    
    const afterPhotosAdded = updated.afterPhotos.filter(p => !original.afterPhotos.includes(p)).length;
    const afterPhotosRemoved = original.afterPhotos.filter(p => !updated.afterPhotos.includes(p)).length;
    if (afterPhotosAdded > 0 || afterPhotosRemoved > 0) {
        let photoChange = 'Fotos "Depois": ';
        if (afterPhotosAdded > 0) photoChange += `adicionou ${afterPhotosAdded}`;
        if (afterPhotosAdded > 0 && afterPhotosRemoved > 0) photoChange += ', ';
        if (afterPhotosRemoved > 0) photoChange += `removeu ${afterPhotosRemoved}`;
        changes.push(photoChange);
    }
    
    return changes.length > 0 ? changes.join('; ') : 'Nenhuma alteração de dados foi feita.';
};

// --- Hooks ---
const useLocalStorage = (key, initialValue) => {
    const [storedValue, setStoredValue] = useState(() => {
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : initialValue;
        } catch (error) { return initialValue; }
    });
    const setValue = (value) => {
        try {
            const valueToStore = value instanceof Function ? value(storedValue) : value;
            setStoredValue(valueToStore);
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (error) { console.error(error); }
    };
    return [storedValue, setValue];
};

// --- Componentes ---

const Header = ({ view, currentUser, onBack, onLogout }) => {
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
    };
    
    return jsxs("header", {
        className: isAdmin ? 'admin-header' : '',
        children: [
            showBackButton && jsx("button", { className: "button button-sm button-secondary header-back-button", onClick: onBack, children: "< Voltar" }),
            jsx("h1", { children: getTitle() }),
            showLogoutButton && jsx("button", { className: "button button-sm button-danger header-logout-button", onClick: onLogout, children: "Sair" })
        ]
    });
};

const Loader = ({ text = "Carregando..." }) => (
  jsxs("div", { className: "loader-container", children: [
      jsx("div", { className: "spinner" }),
      jsx("p", { children: text })
  ]})
);

const CameraView = ({ onCapture, onCancel, onFinish, photoCount }) => {
    const videoRef = useRef(null);
    const [stream, setStream] = useState(null);

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
    
    return jsxs("div", { className: "camera-view", children: [
        jsx("video", { ref: videoRef, autoPlay: true, playsInline: true, muted: true }),
        jsxs("div", { className: "camera-controls", children: [
            jsx("button", { className: "button button-secondary", onClick: onCancel, children: "Cancelar" }),
            jsx("button", { id: "shutter-button", onClick: handleTakePhoto, "aria-label": "Tirar Foto" }),
            jsx("button", { className: "button button-success", onClick: onFinish, disabled: photoCount === 0, children: "Encerrar" })
        ]})
    ]});
};

const Login = ({ onLogin }) => {
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
            
            const user = {
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

    return jsxs("div", { className: "login-container card", children: [
        jsx("h2", { children: "Login de Acesso" }),
        jsx("p", { children: "Entre com suas credenciais." }),
        error && jsx("p", { className: "text-danger", children: error }),
        jsx("input", { type: "email", placeholder: "E-mail", value: email, onChange: e => setEmail(e.target.value) }),
        jsx("input", { type: "password", placeholder: "Senha", value: password, onChange: e => setPassword(e.target.value) }),
        jsx("button", { className: "button", onClick: handleLogin, disabled: isLoading, children: isLoading ? 'Entrando...' : 'Entrar' })
    ]});
};

const AdminDashboard = ({ onNavigate, onBackup, onRestore }) => (
    jsxs("div", { className: "admin-dashboard", children: [
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('ADMIN_MANAGE_SERVICES'), children: "Gerenciar Tipos de Serviço" }),
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('ADMIN_MANAGE_LOCATIONS'), children: "Gerenciar Locais" }),
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('ADMIN_MANAGE_USERS'), children: "Gerenciar Funcionários" }),
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('REPORTS'), children: "Gerador de Relatórios" }),
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('HISTORY'), children: "Histórico Geral" }),
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('ADMIN_MANAGE_GOALS'), children: "🎯 Metas de Desempenho" }),
        jsx("button", { className: "button admin-button", onClick: () => onNavigate('AUDIT_LOG'), children: "📜 Log de Auditoria" }),
        jsx("button", { className: "button admin-button", onClick: onBackup, children: "💾 Fazer Backup Geral (Local)" }),
        jsx("button", { className: "button admin-button", onClick: onRestore, children: "🔄 Restaurar Backup (Local)" })
    ]})
);

const FiscalDashboard = ({ onNavigate }) => (
    jsxs("div", { className: "admin-dashboard", children: [
        jsx("button", { className: "button", onClick: () => onNavigate('REPORTS'), children: "📊 Gerar Relatórios" }),
        jsx("button", { className: "button", onClick: () => onNavigate('HISTORY'), children: "📖 Histórico de Serviços" })
    ]})
);

const OperatorGroupSelect = ({ user, onSelectGroup }) => {
    
    const assignedGroups = [...new Set(user.assignments?.map(a => a.contractGroup) || [])].sort();

    return jsxs("div", { className: "card", children: [
        jsx("h2", { children: "Selecione o Contrato/Cidade" }),
        jsx("div", { className: "city-selection-list", children:
            assignedGroups.length > 0 ? assignedGroups.map(group => (
                jsx("button", { key: group, className: "button", onClick: () => onSelectGroup(group), children: group })
            )) : jsx("p", { children: "Nenhum grupo de trabalho atribuído. Contate o administrador." })
        })
    ]});
};

const OperatorServiceSelect = ({ user, contractGroup, services, onSelectService }) => {
    
    const assignment = user.assignments?.find(a => a.contractGroup === contractGroup);
    const availableServiceNames = assignment?.serviceNames || [];
    const availableServices = services.filter(s => availableServiceNames.includes(s.name));

    return jsxs("div", { className: "card", children: [
        jsx("h2", { children: `Escolha o Serviço em "${contractGroup}"` }),
        jsx("div", { className: "service-selection-list", children:
            availableServices.map(service => (
                jsxs("button", { key: service.id, className: "button", onClick: () => onSelectService(service), children: [
                    service.name, " (", service.unit, ")"
                ]})
            ))
        })
    ]});
};

const OperatorLocationSelect = ({ locations, contractGroup, service, onLocationSet }) => {
    const [manualLocationName, setManualLocationName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [gpsLocation, setGpsLocation] = useState(null);
    const [error, setError] = useState(null);
    const [nearbyLocation, setNearbyLocation] = useState(null);

    const contractLocations = locations.filter(l => l.contractGroup === contractGroup);

    useEffect(() => {
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const currentCoords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
                setGpsLocation(currentCoords);
                setError(null);
                const closest = contractLocations
                    .filter(l => l.coords)
                    .map(l => ({ ...l, distance: calculateDistance(currentCoords, l.coords) }))
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

    const handleSelectFromList = (loc) => {
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

    return jsxs("div", { className: "card", children: [
        jsx("h2", { children: `Selecione o Local em "${contractGroup}"` }),
        jsxs("p", { children: [jsx("strong", { children: "Serviço:" }), " ", service.name, " (", service.unit, ")"] }),
        error && jsx("p", { className: "text-danger", children: error }),

        !gpsLocation && !error && jsx(Loader, { text: "Obtendo sinal de GPS..." }),
        
        nearbyLocation && (
            jsxs("div", { className: "card-inset", children: [
                jsx("h4", { children: "Local Próximo Encontrado via GPS" }),
                jsx("p", { children: jsx("strong", { children: nearbyLocation.name }) }),
                jsx("p", { children: "Você está neste local?" }),
                jsx("button", { className: "button", onClick: handleConfirmNearby, children: "Sim, Confirmar e Continuar" })
            ]})
        ),
        
         jsxs("div", { className: "card-inset", children: [
            jsx("h4", { children: "Ou, busque na lista" }),
            jsx("input", { 
                type: "search", 
                placeholder: "Digite para buscar um local...", 
                value: searchQuery,
                onChange: e => setSearchQuery(e.target.value),
                style: {marginBottom: '1rem'}
            }),
            jsx("div", { className: "location-selection-list", children:
                filteredLocations.length > 0 ? filteredLocations.map(loc => (
                    jsx("button", { key: loc.id, className: "button button-secondary", onClick: () => handleSelectFromList(loc), children: loc.name })
                )) : jsx("p", { children: "Nenhum local encontrado com esse nome." })
            })
         ]}),

         jsxs("div", { className: "card-inset", children: [
            jsx("h4", { children: "Ou, crie um novo local" }),
            jsx("input", { type: "text", placeholder: "Digite o nome do NOVO local", value: manualLocationName, onChange: e => setManualLocationName(e.target.value) }),
            jsx("button", { className: "button", onClick: handleConfirmNewManual, disabled: !manualLocationName.trim(), children: "Confirmar Novo Local" })
         ]})
    ]});
};

const PhotoStep = ({ phase, onComplete, onCancel }) => {
    const [photos, setPhotos] = useState([]);
    const [isTakingPhoto, setIsTakingPhoto] = useState(false);
    const fileInputRef = useRef(null);
    const title = phase === 'BEFORE' ? 'Fotos Iniciais ("Antes")' : 'Fotos Finais ("Depois")';
    const instruction = `Capture fotos do local ${phase === 'BEFORE' ? 'antes' : 'após'} o serviço. Tire quantas quiser. Pressione 'Encerrar' quando terminar.`;

    const handleCapture = (dataUrl) => {
        setPhotos(p => [...p, dataUrl]);
    };

    const handleFileSelect = (event) => {
        const file = event.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const dataUrl = e.target?.result;
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
        return jsx(CameraView, { onCapture: handleCapture, onCancel: () => setIsTakingPhoto(false), onFinish: () => setIsTakingPhoto(false), photoCount: photos.length });
    }

    return jsxs("div", { className: "card", children: [
        jsx("h2", { children: title }),
        jsx("p", { children: instruction }),
        jsxs("div", { className: "photo-section", children: [
            jsx("h3", { children: `Fotos Capturadas (${photos.length})` }),
            jsx("div", { className: "photo-gallery", children:
                photos.map((p, i) => jsx("img", { key: i, src: p, alt: `Foto ${i+1}`, className: "image-preview" }))
            }),
            jsx("input", {
                type: "file",
                ref: fileInputRef,
                onChange: handleFileSelect,
                style: { display: 'none' },
                accept: "image/*",
                multiple: true
            }),
            jsxs("div", { className: "photo-actions", children: [
                jsx("button", { className: "button", onClick: () => setIsTakingPhoto(true), children: `📷 ${photos.length > 0 ? 'Tirar Outra Foto' : 'Iniciar Captura'}` }),
                jsx("button", { className: "button button-secondary", onClick: handleUploadClick, children: "🖼️ Adicionar Foto do Dispositivo" })
            ] })
        ] }),
        jsxs("div", { style: {display: 'flex', gap: '1rem', marginTop: '1rem'}, children: [
            jsx("button", { className: "button button-danger", onClick: onCancel, children: "Cancelar" }),
            jsx("button", { className: "button button-success", onClick: () => onComplete(photos), disabled: photos.length === 0, children: "✅ Encerrar Captação" })
        ] })
    ] });
};

const ConfirmStep = ({ recordData, onSave, onCancel }) => (
    jsxs("div", { className: "card", children: [
        jsx("h2", { children: "Confirmação e Salvamento" }),
        jsxs("div", { className: "detail-section", style: {textAlign: 'left'}, children: [
            jsxs("p", { children: [ jsx("strong", { children: "Contrato/Cidade:" }), ` ${recordData.contractGroup}` ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Serviço:" }), ` ${recordData.serviceType}` ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Local:" }), ` ${recordData.locationName} ${recordData.gpsUsed ? '📍(GPS)' : ''}` ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Data/Hora:" }), ` ${formatDateTime(new Date().toISOString())}` ] }),
            recordData.locationArea ? jsxs("p", { children: [ jsx("strong", { children: "Metragem:" }), ` ${recordData.locationArea} ${recordData.serviceUnit}` ] }) : jsx("p", { children: [ jsx("strong", { children: "Metragem:" }), " Não informada (novo local)" ] }),
            
            jsx("p", { children: "O registro e as fotos foram enviados ao servidor." })
        ]}),
        jsxs("div", { style: {display: 'flex', gap: '1rem'}, children: [
            jsx("button", { className: "button button-danger", onClick: onCancel, children: "Cancelar" }),
            jsx("button", { className: "button button-success", onClick: onSave, children: "✅ Concluir" })
        ]})
    ]})
);

const HistoryView = ({ records, onSelect, isAdmin, onEdit, onDelete }) => (
    jsx("div", { children: 
        records.length === 0 ? jsx("p", { style: {textAlign: 'center'}, children: "Nenhum serviço registrado ainda." })
        : (
            jsx("ul", { className: "history-list", children:
                records.map(record => (
                    jsxs("li", { key: record.id, className: "list-item", children: [
                        jsxs("div", { onClick: () => onSelect(record), children: [
                            jsxs("p", { children: [ jsx("strong", { children: "Local:" }), ` ${record.locationName}, ${record.contractGroup} `, record.gpsUsed && jsx("span", { className: "gps-indicator", children: "📍" }) ] }),
                            jsxs("p", { children: [ jsx("strong", { children: "Serviço:" }), ` ${record.serviceType}` ] }),
                            jsxs("p", { children: [ jsx("strong", { children: "Data:" }), ` ${formatDateTime(record.startTime)}` ] }),
                            isAdmin && jsxs("p", { children: [ jsx("strong", { children: "Operador:" }), ` ${record.operatorName}` ] }),
                            jsxs("div", { className: "history-item-photos", children: [
                               record.beforePhotos.slice(0,2).map((p,i) => jsx("img", { key: `b-${i}`, src: `${API_BASE}${p}` })),
                               record.afterPhotos.slice(0,2).map((p,i) => jsx("img", { key: `a-${i}`, src: `${API_BASE}${p}` }))
                            ]})
                        ]}),
                        isAdmin && onEdit && onDelete && (
                             jsxs("div", { className: "list-item-actions", children: [
                                jsx("button", { className: "button button-sm admin-button", onClick: (e) => { e.stopPropagation(); onEdit(record); }, children: "Editar" }),
                                jsx("button", { className: "button button-sm button-danger", onClick: (e) => { e.stopPropagation(); onDelete(record.id); }, children: "Excluir" })
                            ]})
                        )
                    ]})
                ))
            })
        )
    })
);

const DetailView = ({ record }) => (
     jsxs("div", { className: "detail-view", children: [
        jsxs("div", { className: "detail-section card", children: [
            jsx("h3", { children: "Resumo" }),
            jsxs("p", { children: [ jsx("strong", { children: "Contrato/Cidade:" }), ` ${record.contractGroup}` ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Local:" }), ` ${record.locationName} `, record.gpsUsed && jsx("span", { className: 'gps-indicator', children: "📍(GPS)" }) ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Serviço:" }), ` ${record.serviceType}` ] }),
            record.locationArea ? jsxs("p", { children: [ jsx("strong", { children: "Metragem:" }), ` ${record.locationArea} ${record.serviceUnit}` ] }) : jsx("p", { children: [ jsx("strong", { children: "Metragem:" }), " Não informada" ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Operador:" }), ` ${record.operatorName}` ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Início:" }), ` ${formatDateTime(record.startTime)}` ] }),
            jsxs("p", { children: [ jsx("strong", { children: "Fim:" }), ` ${formatDateTime(record.endTime)}` ] })
        ]}),
        jsxs("div", { className: "detail-section card", children: [
            jsx("h3", { children: `Fotos "Antes" (${record.beforePhotos.length})` }),
            jsx("div", { className: "photo-gallery", children: record.beforePhotos.map((p,i) => jsx("img", { key: i, src: `${API_BASE}${p}`, alt: `Antes ${i+1}` }))})
        ]}),
        jsxs("div", { className: "detail-section card", children: [
            jsx("h3", { children: `Fotos "Depois" (${record.afterPhotos.length})` }),
            jsx("div", { className: "photo-gallery", children: record.afterPhotos.map((p,i) => jsx("img", { key: i, src: `${API_BASE}${p}`, alt: `Depois ${i+1}` }))})
        ]})
    ]})
);

const ReportsView = ({ records, services }) => {
    const [reportType, setReportType] = useState(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [selectedServices, setSelectedServices] = useState([]);
    const [selectedContractGroup, setSelectedContractGroup] = useState('');
    const [selectedIds, setSelectedIds] = useState([]);
    const printableRef = useRef(null);
    
    const allServiceNames = services.map(s => s.name);
    const allContractGroups = [...new Set(records.map(r => r.contractGroup))].sort();

    const handleServiceFilterChange = (service, isChecked) => {
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

    const handleSelectAll = (e) => {
        if(e.target.checked) setSelectedIds(filteredRecords.map(r => r.id));
        else setSelectedIds([]);
    }

    const handleSelectOne = (id, isChecked) => {
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
            const page = pages[i];
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
            jsxs("div", { className: "card", children: [
                jsx("h2", { children: "Selecione o Tipo de Relatório" }),
                jsxs("div", { className: "button-group", style:{flexDirection: 'column', gap: '1rem'}, children: [
                    jsx("button", { className: "button", onClick: () => setReportType('excel'), children: "📊 Relatório Planilha de Excel" }),
                    jsx("button", { className: "button button-secondary", onClick: () => setReportType('photos'), children: "🖼️ Relatório de Fotografias (PDF)" })
                ]})
            ]})
        )
    }

    return jsxs("div", { children: [
        jsxs("div", { className: "card report-filters", children: [
            jsxs("div", { className: "form-group", children: [
                jsx("label", { htmlFor: "start-date", children: "Data de Início" }),
                jsx("input", { id: "start-date", type: "date", value: startDate, onChange: e => setStartDate(e.target.value) })
            ]}),
            jsxs("div", { className: "form-group", children: [
                jsx("label", { htmlFor: "end-date", children: "Data Final" }),
                jsx("input", { id: "end-date", type: "date", value: endDate, onChange: e => setEndDate(e.target.value) })
            ]}),
             jsxs("div", { className: "form-group", children: [
                jsx("label", { htmlFor: "group-filter", children: "Contrato/Cidade" }),
                jsxs("select", { id: "group-filter", value: selectedContractGroup, onChange: e => setSelectedContractGroup(e.target.value), children: [
                    jsx("option", { value: "", children: "Todos" }),
                    allContractGroups.map(group => (
                        jsx("option", { key: group, value: group, children: group })
                    ))
                ]})
            ]}),
            jsxs("fieldset", { className: "form-group-full", children: [
                jsx("legend", { children: "Filtrar por Serviço" }),
                jsx("div", { className: "checkbox-group", children:
                    allServiceNames.map(service => (
                        jsxs("div", { key: service, className: "checkbox-item", children: [
                            jsx("input", { type: "checkbox", id: `service-${service}`, checked: selectedServices.includes(service), onChange: e => handleServiceFilterChange(service, e.target.checked) }),
                            jsx("label", { htmlFor: `service-${service}`, children: service })
                        ]})
                    ))
                })
            ]})
        ]}),

        jsxs("div", { className: "report-list", children: [
            filteredRecords.length > 0 && (
                 jsxs("div", { className: "report-item", children: [
                    jsx("input", { type: "checkbox", onChange: handleSelectAll, checked: selectedIds.length === filteredRecords.length && filteredRecords.length > 0 }),
                    jsx("div", { className: "report-item-info", children: jsx("strong", { children: "Selecionar Todos" }) })
                ]})
            ),
            filteredRecords.map(r => (
                jsxs("div", { key: r.id, className: "report-item", children: [
                    jsx("input", { type: "checkbox", checked: selectedIds.includes(r.id), onChange: e => handleSelectOne(r.id, e.target.checked) }),
                    jsxs("div", { className: "report-item-info", children: [
                        jsxs("p", { children: [jsx("strong", { children: `${r.locationName}, ${r.contractGroup}` })] }),
                        jsxs("p", { children: [r.serviceType, " - ", formatDateTime(r.startTime), " - ", r.locationArea || 0, " ", r.serviceUnit] })
                    ]})
                ]})
            ))
        ]}),

        selectedIds.length > 0 && (
            jsxs("div", { className: "report-summary card", children: [
                jsx("h3", { children: "Resumo da Exportação" }),
                jsx("p", { children: `${selectedRecords.length} registro(s) selecionado(s).` }),
                jsxs("p", { children: ["Total de medição (unidades somadas): ", jsx("strong", { children: totalArea.toLocaleString('pt-BR') })] }),
                jsxs("div", { className: "button-group", children: [
                    reportType === 'excel' && jsx("button", { className: "button", onClick: handleExportExcel, children: "📊 Exportar Excel" }),
                    reportType === 'photos' && jsx("button", { className: "button button-secondary", onClick: handleExportPdf, children: "🖼️ Exportar PDF c/ Fotos" })
                ]})
            ]})
        ),
        
        jsx("div", { className: "printable-report", ref: printableRef, children:
            selectedRecords.map(r => (
                jsxs("div", { key: r.id, className: "printable-report-page", children: [
                    jsxs("div", { className: "printable-page-header", children: [
                        jsx("h2", { children: "Relatório de Serviço - CRB Serviços" }),
                        jsxs("p", { children: [jsx("strong", { children: "Contrato/Cidade:" }), ` ${r.contractGroup}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Local:" }), ` ${r.locationName}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Serviço:" }), ` ${r.serviceType}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Data:" }), ` ${formatDateTime(r.startTime)}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Medição:" }), ` ${r.locationArea ? `${r.locationArea.toLocaleString('pt-BR')} ${r.serviceUnit}` : 'Não informada'}`] })
                    ]}),
                    jsx("h3", { children: 'Fotos "Antes"' }),
                    jsx("div", { className: "printable-report-gallery", children:
                        r.beforePhotos.map((p, i) => (
                            jsxs("div", { key: `before-${i}`, className: "photo-item-container", children: [
                                jsx("img", { src: `${API_BASE}${p}`, alt: `Foto Antes ${i + 1}` }),
                                jsxs("p", { className: "caption", children: ["Antes ", i + 1] })
                            ]})
                        ))
                    }),
                    jsx("h3", { children: 'Fotos "Depois"' }),
                    jsx("div", { className: "printable-report-gallery", children:
                        r.afterPhotos.map((p, i) => (
                            jsxs("div", { key: `after-${i}`, className: "photo-item-container", children: [
                                jsx("img", { src: `${API_BASE}${p}`, alt: `Foto Depois ${i + 1}` }),
                                jsxs("p", { className: "caption", children: ["Depois ", i + 1] })
                            ]})
                        ))
                    })
                ]})
            ))
        })
    ]});
};

const ManageLocationsView = ({ locations, setLocations }) => {
    const [selectedGroup, setSelectedGroup] = useState('');
    const [name, setName] = useState('');
    const [area, setArea] = useState('');
    const [coords, setCoords] = useState(null);
    const [isFetchingCoords, setIsFetchingCoords] = useState(false);
    const [editingId, setEditingId] = useState(null);

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
    
    const handleCoordChange = (field, valueStr) => {
        const value = parseFloat(valueStr);
        setCoords(curr => {
            const newCoords = { ...(curr || {}) };
            newCoords[field] = isNaN(value) ? undefined : value;
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
                const updatedLoc = await apiFetch(`/api/locations/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
                setLocations(locations.map(l => l.id === editingId ? {
                    id: String(updatedLoc.id),
                    name: updatedLoc.name,
                    contractGroup: updatedLoc.city,
                    area: updatedLoc.area,
                    coords: updatedLoc.lat && updatedLoc.lng ? { latitude: updatedLoc.lat, longitude: updatedLoc.lng } : undefined
                } : l));
            } else {
                const newLoc = await apiFetch('/api/locations', { method: 'POST', body: JSON.stringify(payload) });
                setLocations([{
                    id: String(newLoc.id),
                    name: newLoc.name,
                    contractGroup: newLoc.city,
                    area: newLoc.area,
                    coords: newLoc.lat && newLoc.lng ? { latitude: newLoc.lat, longitude: newLoc.lng } : undefined
                }, ...locations]);
            }
            resetForm();
        } catch (error) {
            alert('Falha ao salvar local. Tente novamente.');
            console.error(error);
        }
    };

    const handleEdit = (loc) => {
        setEditingId(loc.id);
        setName(loc.name);
        setArea(String(loc.area));
        setCoords(loc.coords || null);
        setSelectedGroup(loc.contractGroup);
    };

    const handleDelete = async (id) => {
        if(window.confirm('Excluir este local?')) {
            try {
                await apiFetch(`/api/locations/${id}`, { method: 'DELETE' });
                setLocations(locations.filter(l => l.id !== id));
            } catch (error) {
                alert('Falha ao excluir local. Tente novamente.');
                console.error(error);
            }
        }
    };
    
    const filteredLocations = selectedGroup ? locations.filter(l => l.contractGroup === selectedGroup) : [];

    return jsxs("div", { children: [
        jsxs("div", { className: "card", children: [
            jsx("h3", { children: "Gerenciar Locais por Contrato/Cidade" }),
            jsx("input", { 
                list: "contract-groups", 
                placeholder: "Digite ou selecione um Contrato/Cidade", 
                value: selectedGroup, 
                onChange: e => {setSelectedGroup(e.target.value); resetForm();}
            }),
            jsx("datalist", { id: "contract-groups", children:
                allGroups.map(g => jsx("option", { key: g, value: g }))
            })
        ]}),
        
        selectedGroup && jsxs(React.Fragment, { children: [
            jsxs("div", { className: "form-container card", children: [
                jsx("h3", { children: `${editingId ? 'Editando Local' : 'Adicionar Novo Local'} em "${selectedGroup}"` }),
                jsx("input", { type: "text", placeholder: "Nome do Local", value: name, onChange: e => setName(e.target.value) }),
                jsx("input", { type: "number", placeholder: "Metragem (use a unidade do serviço)", value: area, onChange: e => setArea(e.target.value) }),
                
                jsxs("div", { className: "form-group", style: {marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '1rem'}, children: [
                     jsx("label", { children: "Coordenadas GPS (Opcional)" }),
                     jsx("p", { style: {fontSize: '0.8rem', color: '#666', margin: '0.25rem 0'}, children: "Preencha manualmente ou clique no botão para capturar as coordenadas GPS atuais." }),
                     jsxs("div", { className: "coord-inputs", children: [
                        jsx("input", { type: "number", step: "any", placeholder: "Latitude", value: coords?.latitude ?? '', onChange: e => handleCoordChange('latitude', e.target.value) }),
                        jsx("input", { type: "number", step: "any", placeholder: "Longitude", value: coords?.longitude ?? '', onChange: e => handleCoordChange('longitude', e.target.value) })
                     ]}),
                     jsx("button", { className: "button button-secondary", onClick: handleGetCoordinates, disabled: isFetchingCoords, children:
                        isFetchingCoords ? 'Obtendo GPS...' : '📍 Obter Coordenadas GPS Atuais'
                    })
                ]}),

                jsx("button", { className: "button admin-button", onClick: handleSave, children: editingId ? 'Salvar Alterações' : 'Adicionar Local' }),
                editingId && jsx("button", { className: "button button-secondary", onClick: resetForm, children: "Cancelar Edição" })
            ]}),
            jsx("ul", { className: "location-list", children:
                filteredLocations.sort((a,b) => a.name.localeCompare(b.name)).map(loc => (
                    jsxs("li", { key: loc.id, className: "card list-item", children: [
                        jsxs("div", { className: "list-item-header", children: [
                            jsx("h3", { children: loc.name }),
                            jsxs("div", { children: [
                                jsx("button", { className: "button button-sm admin-button", onClick: () => handleEdit(loc), children: "Editar" }),
                                jsx("button", { className: "button button-sm button-danger", onClick: () => handleDelete(loc.id), children: "Excluir" })
                            ]})
                        ]}),
                        jsxs("p", { children: [jsx("strong", { children: "Metragem Base:" }), ` ${loc.area}`] }),
                        loc.coords && jsxs("p", { children: [jsx("strong", { children: "GPS:" }), " Sim ", jsx("span", { className: "gps-indicator", children: "📍" })] })
                    ]})
                ))
            })
        ]})
    ]});
};

const ManageUsersView = ({ users, onUsersUpdate, services }) => {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState('OPERATOR');
    const [assignments, setAssignments] = useState([]);
    const [editingId, setEditingId] = useState(null);
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

        const payload = {
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

    const handleEdit = (user) => {
        setEditingId(user.id);
        setUsername(user.username);
        setEmail(user.email || '');
        setPassword(''); // Don't show existing password
        setRole(user.role);
        setAssignments(user.assignments || []);
    };

    const handleDelete = async (id) => {
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
    
    return jsxs("div", { children: [
        jsxs("div", { className: "form-container card", children: [
            jsx("h3", { children: editingId ? 'Editando Funcionário' : 'Adicionar Novo Funcionário' }),
            jsx("input", { type: "text", placeholder: "Nome de usuário", value: username, onChange: e => setUsername(e.target.value) }),
            jsx("input", { type: "email", placeholder: "E-mail", value: email, onChange: e => setEmail(e.target.value) }),
            jsx("input", { type: "text", placeholder: editingId ? 'Nova Senha (deixe em branco para não alterar)' : 'Senha', value: password, onChange: e => setPassword(e.target.value) }),
            jsxs("select", { value: role, onChange: e => setRole(e.target.value), children: [
                jsx("option", { value: "ADMIN", children: "Administrador" }),
                jsx("option", { value: "OPERATOR", children: "Operador" }),
                jsx("option", { value: "FISCAL", children: "Fiscalização" })
            ]}),
            
            jsx("p", { style: {marginTop: '1rem', fontSize: '0.9rem'}, children: "Atenção: A atribuição de contratos/serviços a usuários ainda é uma funcionalidade em desenvolvimento no backend." }),

            jsx("button", { className: "button admin-button", onClick: handleSave, disabled: isLoading, children: isLoading ? 'Salvando...' : (editingId ? 'Salvar Alterações' : 'Adicionar') }),
            editingId && jsx("button", { className: "button button-secondary", onClick: resetForm, children: "Cancelar" })
        ]}),
        jsx("ul", { className: "location-list", children:
             users.map(user => (
                jsxs("li", { key: user.id, className: "card list-item", children: [
                    jsxs("div", { className: "list-item-header", children: [
                        jsx("h3", { children: user.username }),
                        jsxs("div", { children: [
                            jsx("button", { className: "button button-sm admin-button", onClick: () => handleEdit(user), children: "Editar" }),
                            jsx("button", { className: "button button-sm button-danger", onClick: () => handleDelete(user.id), children: "Excluir" })
                        ]})
                    ]}),
                    jsxs("p", { children: [jsx("strong", { children: "Função:" }), ` ${user.role}`] }),
                    jsxs("p", { children: [jsx("strong", { children: "Email:" }), ` ${user.email}`] })
                ]})
             ))
        })
    ]});
};

const ManageGoalsView = ({ goals, setGoals, records, locations }) => {
    const [contractGroup, setContractGroup] = useState('');
    const [month, setMonth] = useState(new Date().toISOString().substring(0, 7)); // YYYY-MM
    const [targetArea, setTargetArea] = useState('');
    const [editingId, setEditingId] = useState(null);
    
    const allGroups = [...new Set(locations.map(l => l.contractGroup).concat(records.map(r => r.contractGroup)))].sort();

    const resetForm = () => {
        setContractGroup('');
        setMonth(new Date().toISOString().substring(0, 7));
        setTargetArea('');
        setEditingId(null);
    };

    const handleSave = () => {
        if (!contractGroup || !month || !targetArea || isNaN(parseFloat(targetArea))) {
            alert('Preencha todos os campos corretamente.');
            return;
        }
        const newGoal = {
            id: editingId || new Date().toISOString(),
            contractGroup,
            month,
            targetArea: parseFloat(targetArea),
        };
        if (editingId) {
            setGoals(prevGoals => prevGoals.map(g => g.id === editingId ? newGoal : g));
        } else {
            setGoals(prevGoals => [newGoal, ...prevGoals]);
        }
        resetForm();
    };

    const handleEdit = (goal) => {
        setEditingId(goal.id);
        setContractGroup(goal.contractGroup);
        setMonth(goal.month);
        setTargetArea(String(goal.targetArea));
    };

    const handleDelete = (id) => {
        if (window.confirm('Excluir esta meta?')) {
            setGoals(prevGoals => prevGoals.filter(g => g.id !== id));
        }
    };

    return jsxs("div", { children: [
        jsxs("div", { className: "form-container card", children: [
            jsx("h3", { children: `${editingId ? 'Editando Meta' : 'Adicionar Nova Meta'} (Local)` }),
             jsx("input", { 
                list: "goal-contract-groups", 
                placeholder: "Digite ou selecione um Contrato/Cidade", 
                value: contractGroup, 
                onChange: e => setContractGroup(e.target.value)
            }),
            jsx("datalist", { id: "goal-contract-groups", children:
                allGroups.map(g => jsx("option", { key: g, value: g }))
            }),
            jsx("input", { type: "month", value: month, onChange: e => setMonth(e.target.value) }),
            jsx("input", { type: "number", placeholder: "Meta de Medição (m² ou m linear)", value: targetArea, onChange: e => setTargetArea(e.target.value) }),
            jsx("button", { className: "button admin-button", onClick: handleSave, children: editingId ? 'Salvar Alterações' : 'Adicionar Meta' }),
            editingId && jsx("button", { className: "button button-secondary", onClick: resetForm, children: "Cancelar Edição" })
        ]}),

        jsx("ul", { className: "goal-list", children:
            [...goals]
                .filter(goal => goal && typeof goal.month === 'string' && typeof goal.contractGroup === 'string')
                .sort((a, b) => b.month.localeCompare(a.month) || a.contractGroup.localeCompare(b.contractGroup))
                .map(goal => {
                    const realizedArea = records
                        .filter(r => r && r.contractGroup === goal.contractGroup && typeof r.startTime === 'string' && r.startTime.startsWith(goal.month))
                        .reduce((sum, r) => sum + (r.locationArea || 0), 0);
                
                    const percentage = goal.targetArea > 0 ? (realizedArea / goal.targetArea) * 100 : 0;
                    const remainingArea = Math.max(0, goal.targetArea - realizedArea);

                    return jsxs("li", { key: goal.id, className: "card list-item progress-card", children: [
                         jsxs("div", { className: "list-item-header", children: [
                            jsx("h3", { children: `${goal.contractGroup} - ${goal.month}` }),
                            jsxs("div", { children: [
                                jsx("button", { className: "button button-sm admin-button", onClick: () => handleEdit(goal), children: "Editar" }),
                                jsx("button", { className: "button button-sm button-danger", onClick: () => handleDelete(goal.id), children: "Excluir" })
                            ]})
                        ]}),
                        jsxs("div", { className: "progress-info", children: [
                            jsx("span", { children: `Realizado: ${realizedArea.toLocaleString('pt-BR')} / ${goal.targetArea.toLocaleString('pt-BR')}` }),
                            jsx("span", { children: `${percentage.toFixed(1)}%` })
                        ]}),
                        jsx("div", { className: "progress-bar-container", children:
                            jsx("div", { className: "progress-bar", style: { width: `${Math.min(percentage, 100)}%` } })
                        }),
                         jsx("p", { className: "remaining-info", children: `Faltam: ${remainingArea.toLocaleString('pt-BR')} para atingir a meta.` })
                    ]});
            })
        })
    ]});
};

const ServiceInProgressView = ({ service, onFinish }) => {
    return (
        jsxs("div", { className: "card", children: [
            jsx("h2", { children: "Serviço em Andamento" }),
            jsxs("div", { className: "detail-section", style: { textAlign: 'left', marginBottom: '1.5rem' }, children: [
                jsxs("p", { children: [jsx("strong", { children: "Contrato/Cidade:" }), ` ${service.contractGroup}`] }),
                jsxs("p", { children: [jsx("strong", { children: "Serviço:" }), ` ${service.serviceType}`] }),
                jsxs("p", { children: [jsx("strong", { children: "Local:" }), ` ${service.locationName}`] }),
                jsxs("p", { children: [jsx("strong", { children: "Início:" }), ` ${service.startTime ? formatDateTime(service.startTime) : 'N/A'}`] })
            ] }),
            jsx("p", { children: "O registro inicial e as fotos \"Antes\" foram salvos no servidor. Complete o serviço no local." }),
            jsx("p", { children: "Quando terminar, clique no botão abaixo para tirar as fotos \"Depois\"." }),
            jsx("button", { className: "button button-success", style: { marginTop: '1.5rem' }, onClick: onFinish, children: "✅ Finalizar e Tirar Fotos \"Depois\""
            })
        ]})
    );
};

const AdminEditRecordView = ({ record, onSave, onCancel, services }) => {
    const [formData] = useState(record);
    
    // This view is now mostly read-only as the backend does not support record updates.
    // The form elements are disabled.

    return jsxs("div", { className: "card edit-form-container", children: [
             jsxs("div", { className: "form-group", children: [
                jsx("label", { children: "Nome do Local" }),
                jsx("input", { type: "text", value: formData.locationName, disabled: true })
            ]}),
            jsxs("div", { className: "form-group", children: [
                jsx("label", { children: "Tipo de Serviço" }),
                jsx("input", { type: "text", value: formData.serviceType, disabled: true })
            ]}),
             jsxs("div", { className: "form-group", children: [
                jsx("label", { children: `Medição (${formData.serviceUnit})` }),
                jsx("input", { type: "number", value: formData.locationArea || '', disabled: true })
            ]}),
            
            jsxs("div", { className: "form-group", children: [
                jsx("h4", { children: `Fotos "Antes" (${formData.beforePhotos.length})` }),
                jsx("div", { className: "edit-photo-gallery", children:
                    formData.beforePhotos.map((p, i) => (
                        jsx("div", { key: i, className: "edit-photo-item", children:
                            jsx("img", { src: `${API_BASE}${p}`, alt: `Antes ${i+1}` })
                        })
                    ))
                })
            ]}),

            jsxs("div", { className: "form-group", children: [
                jsx("h4", { children: `Fotos "Depois" (${formData.afterPhotos.length})` }),
                jsx("div", { className: "edit-photo-gallery", children:
                    formData.afterPhotos.map((p, i) => (
                        jsx("div", { key: i, className: "edit-photo-item", children:
                            jsx("img", { src: `${API_BASE}${p}`, alt: `Depois ${i+1}` })
                        })
                    ))
                })
            ]}),
            
            jsx("p", { className: "text-danger", style: {marginTop: '1rem'}, children: "A edição de registros não é suportada pelo backend no momento. Esta tela é somente para visualização." }),

            jsxs("div", { className: "button-group", children: [
                jsx("button", { className: "button button-secondary", onClick: onCancel, children: "Voltar" }),
                jsx("button", { className: "button button-success", onClick: () => onSave(formData), disabled: true, children: "Salvar Alterações" })
            ]})
    ]});
};

const AuditLogView = ({ log }) => {
    
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

    return jsxs("div", { children: [
        jsxs("div", { className: "audit-log-header", children: [
            jsx("h2", { children: "Registros de Alterações (Local)" }),
            jsx("button", { className: "button admin-button", onClick: handleExportPdf, disabled: log.length === 0, children: "Exportar para PDF"
            })
        ]}),
        log.length === 0 ? (
            jsx("p", { children: "Nenhuma alteração administrativa foi registrada ainda." })
        ) : (
            jsx("ul", { className: "audit-log-list", children:
                log.map(entry => (
                    jsxs("li", { key: entry.id, className: "audit-log-item", children: [
                        jsxs("p", { children: [jsx("strong", { children: "Data:" }), ` ${formatDateTime(entry.timestamp)}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Usuário:" }), ` ${entry.adminUsername}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Ação:" }), ` ${entry.action === 'UPDATE' ? 'Atualização de Registro' : 'Exclusão de Registro'}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "ID do Registro:" }), ` ${entry.recordId}`] }),
                        jsxs("p", { children: [jsx("strong", { children: "Detalhes:" }), ` ${entry.details}`] })
                    ]})
                ))
            })
        )
    ]});
};

const ManageServicesView = ({ services, setServices }) => {
    const [name, setName] = useState('');
    const [unit, setUnit] = useState('m²');
    const [editingId, setEditingId] = useState(null);

    const resetForm = () => {
        setName('');
        setUnit('m²');
        setEditingId(null);
    };

    const handleSave = () => {
        if (!name.trim()) {
            alert('O nome do serviço é obrigatório.');
            return;
        }
        const newService = { id: editingId || new Date().toISOString(), name, unit };
        if (editingId) {
            setServices(prev => prev.map(s => s.id === editingId ? newService : s));
        } else {
            setServices(prev => [newService, ...prev]);
        }
        resetForm();
    };

    const handleEdit = (service) => {
        setEditingId(service.id);
        setName(service.name);
        setUnit(service.unit);
    };

    const handleDelete = (id) => {
        if (window.confirm('Excluir este tipo de serviço? Isso pode afetar usuários e registros existentes.')) {
            setServices(prev => prev.filter(s => s.id !== id));
        }
    };

    return jsxs("div", { children: [
        jsxs("div", { className: "form-container card", children: [
            jsx("h3", { children: `${editingId ? 'Editando Tipo de Serviço' : 'Adicionar Novo Tipo de Serviço'} (Local)` }),
            jsx("input", { type: "text", placeholder: "Nome do Serviço", value: name, onChange: e => setName(e.target.value) }),
            jsxs("select", { value: unit, onChange: e => setUnit(e.target.value), children: [
                jsx("option", { value: "m²", children: "m² (Metros Quadrados)" }),
                jsx("option", { value: "m linear", children: "m linear (Metros Lineares)" })
            ]}),
            jsx("button", { className: "button admin-button", onClick: handleSave, children: editingId ? 'Salvar Alterações' : 'Adicionar Serviço' }),
            editingId && jsx("button", { className: "button button-secondary", onClick: resetForm, children: "Cancelar Edição" })
        ]}),
        jsx("ul", { className: "location-list", children:
            services.sort((a,b) => a.name.localeCompare(b.name)).map(s => (
                jsxs("li", { key: s.id, className: "card list-item", children: [
                    jsxs("div", { className: "list-item-info", children: [
                       jsx("p", { children: jsx("strong", { children: s.name }) }),
                       jsx("p", { children: `Unidade: ${s.unit}` })
                    ]}),
                    jsxs("div", { className: "list-item-actions", children: [
                        jsx("button", { className: "button button-sm admin-button", onClick: () => handleEdit(s), children: "Editar" }),
                        jsx("button", { className: "button button-sm button-danger", onClick: () => handleDelete(s.id), children: "Excluir" })
                    ]})
                ]})
            ))
        })
    ]});
};

// --- Componente Principal ---
const App = () => {
  const [view, setView] = useState('LOGIN');
  const [currentUser, setCurrentUser] = useLocalStorage('crbCurrentUser', null);
  
  // Data from API
  const [users, setUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [records, setRecords] = useState([]);
  
  // Local data
  const [services, setServices] = useLocalStorage('crbServices', DEFAULT_SERVICES);
  const [goals, setGoals] = useLocalStorage('crbGoals', []);
  const [auditLog, setAuditLog] = useLocalStorage('crbAuditLog', []);
  
  const [currentService, setCurrentService] = useLocalStorage('crbCurrentService', {});
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [selectedContractGroup, setSelectedContractGroup] = useState(null);
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(null);

  const navigate = (newView, replace = false) => {
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
  
  const redirectUser = (user) => {
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
        if (currentUser.role === 'ADMIN') {
            const [locs, recs, usrs] = await Promise.all([
                apiFetch('/api/locations'),
                apiFetch('/api/records'),
                apiFetch('/api/users')
            ]);
            setLocations(locs.map((l) => ({id: String(l.id), contractGroup: l.city, name: l.name, area: l.area || 0, coords: (l.lat!=null && l.lng!=null) ? { latitude: l.lat, longitude: l.lng } : undefined })));
            setRecords(recs.map((r) => ({...r, id: String(r.id), contractGroup: r.location_city, operatorId: String(r.operator_id), operatorName: r.operator_name || 'N/A' })));
            setUsers(usrs.map((u) => ({id: String(u.id), username: u.name, email: u.email, role: u.role, assignments: u.assignments || [] })));
        } else if (currentUser.role === 'FISCAL') {
            const recs = await apiFetch('/api/records');
            const fiscalGroups = currentUser.assignments?.map(a => a.contractGroup) || [];
            setRecords(
                recs.filter((r) => fiscalGroups.includes(r.location_city))
                .map((r) => ({...r, id: String(r.id), contractGroup: r.location_city, operatorId: String(r.operator_id), operatorName: r.operator_name || 'N/A' }))
            );
        } else if (currentUser.role === 'OPERATOR') {
             const [locs, recs] = await Promise.all([
                apiFetch('/api/locations'),
                apiFetch(`/api/records?operator_id=${currentUser.id}`)
             ]);
             setLocations(locs.map((l) => ({id: String(l.id), contractGroup: l.city, name: l.name, area: l.area || 0, coords: (l.lat!=null && l.lng!=null) ? { latitude: l.lat, longitude: l.lng } : undefined })));
             setRecords(recs.map((r) => ({...r, id: String(r.id), contractGroup: r.location_city, operatorId: String(r.operator_id), operatorName: r.operator_name || 'N/A' })));
        }
    } catch (error) {
        console.error("Failed to fetch data", error);
        alert("Não foi possível carregar os dados do servidor.");
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
            const user = { id: String(me.id), username: me.name, email: me.email, role: me.role, assignments: me.assignments || [] };
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
      redirectUser(currentUser);
  }

  const handleLogin = (user) => {
    setCurrentUser(user);
    redirectUser(user);
  };

  const handleBackup = () => {
      alert("O backup agora deve ser realizado diretamente no servidor/banco de dados.");
  };

  const handleRestore = () => {
      alert("A restauração de dados agora deve ser realizada diretamente no servidor/banco de dados.");
  };

  const handleGroupSelect = (group) => {
      setSelectedContractGroup(group);
      navigate('OPERATOR_SERVICE_SELECT');
  }

  const handleServiceSelect = (service) => {
    setCurrentService({ serviceType: service.name, serviceUnit: service.unit, contractGroup: selectedContractGroup });
    navigate('OPERATOR_LOCATION_SELECT');
  };

  const handleLocationSet = (locData) => {
      setCurrentService(s => ({...s, ...locData}));
      navigate('PHOTO_STEP');
  };

  const handleBeforePhotos = async (photos) => {
      if (!currentUser || !currentService.serviceType || !currentService.contractGroup) {
          alert("Erro: Dados do serviço incompletos.");
          return;
      }
      setIsLoading("Criando registro e enviando fotos 'Antes'...");
      try {
          const recordPayload = {
              operator_id: parseInt(currentUser.id, 10),
              service_type: currentService.serviceType,
              location_id: currentService.locationId ? parseInt(currentService.locationId, 10) : undefined,
              location_name: currentService.locationName,
              location_city: currentService.contractGroup,
              location_area: currentService.locationArea,
              gps_used: !!currentService.gpsUsed,
              start_time: new Date().toISOString()
          };
          const newRecord = await apiFetch('/api/records', { method: 'POST', body: JSON.stringify(recordPayload) });
          
          const photoFiles = photos.map((dataUrl, i) => dataURLtoFile(dataUrl, `before_${i}.jpg`));
          if (photoFiles.length > 0) {
              const formData = new FormData();
              formData.append('phase', 'BEFORE');
              photoFiles.forEach(file => formData.append('files', file));
              await apiFetch(`/api/records/${newRecord.id}/photos`, { method: 'POST', body: formData });
          }

          setCurrentService(s => ({...s, id: String(newRecord.id), startTime: newRecord.start_time }));
          navigate('OPERATOR_SERVICE_IN_PROGRESS');
      } catch(e) {
          alert("Falha ao salvar fotos 'Antes'. Tente novamente.");
          console.error(e);
      } finally {
          setIsLoading(null);
      }
  };

  const handleAfterPhotos = async (photos) => {
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
          
          // Optionally update record with end_time if backend supports it
          // await apiFetch(`/api/records/${currentService.id}`, { method: 'PUT', body: JSON.stringify({ end_time: new Date().toISOString() }) });
          
          setCurrentService(s => ({...s, endTime: new Date().toISOString()}));
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

  const handleSelectRecord = async (record) => {
    setIsLoading("Carregando detalhes...");
    try {
        const detailedRecord = await apiFetch(`/api/records/${record.id}`);
        const fullRecord = {
            ...record,
            beforePhotos: detailedRecord.before_photos || [],
            afterPhotos: detailedRecord.after_photos || [],
        };
        setSelectedRecord(fullRecord);
        navigate('DETAIL');
    } catch (e) {
        alert('Não foi possível carregar os detalhes do registro.');
    } finally {
        setIsLoading(null);
    }
  }

  const handleEditRecord = (record) => {
      setSelectedRecord(record);
      navigate('ADMIN_EDIT_RECORD');
  };

  const handleUpdateRecord = (updatedRecord) => {
    alert("A edição de registros não está implementada no backend.");
  };

  const handleDeleteRecord = async (recordId) => {
      if (!currentUser || currentUser.role !== 'ADMIN') return;
      
      const recordToDelete = records.find(r => r.id === recordId);
      if (!recordToDelete) return;

      if (window.confirm(`Tem certeza que deseja excluir o registro do local "${recordToDelete.locationName}"? Esta ação não pode ser desfeita.`)) {
          try {
              await apiFetch(`/api/records/${recordId}`, { method: 'DELETE' });
              const logEntry = {
                  id: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                  adminId: currentUser.id,
                  adminUsername: currentUser.username,
                  action: 'DELETE',
                  recordId: recordId,
                  details: `Registro excluído via app: ${recordToDelete.serviceType} em ${recordToDelete.locationName}, ${recordToDelete.contractGroup}.`,
              };
              setAuditLog(prev => [logEntry, ...prev]);
              setRecords(prev => prev.filter(r => r.id !== recordId));
              alert("Registro excluído com sucesso.");
          } catch(e) {
              alert("Falha ao excluir o registro.");
              console.error(e);
          }
      }
  };

  const renderView = () => {
    if (!currentUser && view !== 'LOGIN') {
        return jsx(Loader, { text: "Verificando sessão..." });
    }
    if (!currentUser) {
        return jsx(Login, { onLogin: handleLogin });
    }
    
    switch(currentUser.role) {
        case 'ADMIN':
            switch(view) {
                case 'ADMIN_DASHBOARD': return jsx(AdminDashboard, { onNavigate: navigate, onBackup: handleBackup, onRestore: handleRestore });
                case 'ADMIN_MANAGE_SERVICES': return jsx(ManageServicesView, { services: services, setServices: setServices });
                case 'ADMIN_MANAGE_LOCATIONS': return jsx(ManageLocationsView, { locations: locations, setLocations: setLocations });
                case 'ADMIN_MANAGE_USERS': return jsx(ManageUsersView, { users: users, onUsersUpdate: fetchData, services: services });
                case 'ADMIN_MANAGE_GOALS': return jsx(ManageGoalsView, { goals: goals, setGoals: setGoals, records: records, locations: locations });
                case 'REPORTS': return jsx(ReportsView, { records: records, services: services });
                case 'HISTORY': return jsx(HistoryView, { records: records, onSelect: handleSelectRecord, isAdmin: true, onEdit: handleEditRecord, onDelete: handleDeleteRecord });
                case 'DETAIL': return selectedRecord ? jsx(DetailView, { record: selectedRecord }) : jsx("p", { children: "Registro não encontrado." });
                case 'ADMIN_EDIT_RECORD': return selectedRecord ? jsx(AdminEditRecordView, { record: selectedRecord, onSave: handleUpdateRecord, onCancel: handleBack, services: services }) : jsx("p", { children: "Nenhum registro selecionado para edição." });
                case 'AUDIT_LOG': return jsx(AuditLogView, { log: auditLog });
                default: return jsx(AdminDashboard, { onNavigate: navigate, onBackup: handleBackup, onRestore: handleRestore });
            }
        
        case 'FISCAL':
            const fiscalGroups = currentUser.assignments?.map(a => a.contractGroup) || [];
            const fiscalRecords = records.filter(r => fiscalGroups.includes(r.contractGroup));
            switch(view) {
                case 'FISCAL_DASHBOARD': return jsx(FiscalDashboard, { onNavigate: navigate });
                case 'REPORTS': return jsx(ReportsView, { records: fiscalRecords, services: services });
                case 'HISTORY': return jsx(HistoryView, { records: fiscalRecords, onSelect: handleSelectRecord, isAdmin: false });
                case 'DETAIL':
                    const canView = selectedRecord && fiscalGroups.includes(selectedRecord.contractGroup);
                    return canView ? jsx(DetailView, { record: selectedRecord }) : jsx("p", { children: "Registro não encontrado ou acesso não permitido." });
                default: return jsx(FiscalDashboard, { onNavigate: navigate });
            }

        case 'OPERATOR':
            switch(view) {
                case 'OPERATOR_GROUP_SELECT': return jsx(OperatorGroupSelect, { user: currentUser, onSelectGroup: handleGroupSelect });
                case 'OPERATOR_SERVICE_SELECT': return selectedContractGroup ? jsx(OperatorServiceSelect, { user: currentUser, contractGroup: selectedContractGroup, services: services, onSelectService: handleServiceSelect }) : null;
                case 'OPERATOR_LOCATION_SELECT': return selectedContractGroup && currentService.serviceType ? jsx(OperatorLocationSelect, { locations: locations, contractGroup: selectedContractGroup, service:{id: '', name: currentService.serviceType, unit: currentService.serviceUnit}, onLocationSet: handleLocationSet }) : null;
                case 'OPERATOR_SERVICE_IN_PROGRESS': return jsx(ServiceInProgressView, { service: currentService, onFinish: () => navigate('PHOTO_STEP') });
                case 'PHOTO_STEP': 
                    if(!currentService.id) {
                        return jsx(PhotoStep, { phase: "BEFORE", onComplete: handleBeforePhotos, onCancel: resetService });
                    }
                    return jsx(PhotoStep, { phase: "AFTER", onComplete: handleAfterPhotos, onCancel: resetService });
                case 'CONFIRM_STEP': return jsx(ConfirmStep, { recordData: currentService, onSave: handleSave, onCancel: resetService });
                case 'HISTORY': 
                    const operatorRecords = records.filter(r => r.operatorId === currentUser.id);
                    return jsx(HistoryView, { records: operatorRecords, onSelect: handleSelectRecord, isAdmin: false });
                case 'DETAIL': return selectedRecord ? jsx(DetailView, { record: selectedRecord }) : jsx("p", { children: "Registro não encontrado." });
                default: return jsx(OperatorGroupSelect, { user: currentUser, onSelectGroup: handleGroupSelect });
            }
        
        default:
             handleLogout();
             return null;
    }
  };

  return jsxs("div", { className: "app-container", children: [
      isLoading && jsxs("div", { className: "loader-overlay", children: [
          jsx("div", { className: "spinner" }),
          jsx("p", { children: isLoading })
      ]}),
      jsx(Header, { view: view, currentUser: currentUser, onBack: view !== 'LOGIN' && view !== 'ADMIN_DASHBOARD' && view !== 'FISCAL_DASHBOARD' ? handleBack : undefined, onLogout: handleLogout }),
      jsx("main", { children: renderView() })
  ]});
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(jsx(App, {}));
}