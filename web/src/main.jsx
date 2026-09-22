import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './components/ui.jsx';
import AuthGate from './components/AuthGate.jsx';
import { AuthProvider } from './lib/auth.jsx';
import AcceptQuotation from './pages/AcceptQuotation.jsx';
import './styles.css';

// A client's acceptance link (#53) opens outside the signed-in app.
const acceptToken = window.location.pathname.match(/^\/accept\/([A-Za-z0-9_-]+)$/)?.[1];

createRoot(document.getElementById('root')).render(
  acceptToken ? <React.StrictMode><AcceptQuotation token={acceptToken} /></React.StrictMode> :
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AuthGate>
            <App />
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
