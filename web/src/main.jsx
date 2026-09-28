import React from 'react';
import './styles/globals.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './components/ui.jsx';
import AuthGate from './components/AuthGate.jsx';
import { AuthProvider } from './lib/auth.jsx';
import AcceptQuotation from './pages/AcceptQuotation.jsx';
import Portal from './pages/Portal.jsx';
import { startErrorReporting } from './lib/errorReporting.js';
import { EnvironmentBanner } from './components/EnvironmentBanner.jsx';

startErrorReporting();

// A client's acceptance link (#53) opens outside the signed-in app.
const acceptToken = window.location.pathname.match(/^\/accept\/([A-Za-z0-9_-]+)$/)?.[1];
// The client portal (#47) is its own small app with its own sign-in.
const portalPath = window.location.pathname.match(/^\/portal(?:\/login\/([A-Za-z0-9_-]+))?\/?$/);

// Outside the app's own root, so every page shows it, the client-facing ones included.
const bannerRoot = document.createElement('div');
document.body.prepend(bannerRoot);
createRoot(bannerRoot).render(<EnvironmentBanner />);

createRoot(document.getElementById('root')).render(
  acceptToken ? <React.StrictMode><AcceptQuotation token={acceptToken} /></React.StrictMode> :
  portalPath ? <Portal loginToken={portalPath[1]} /> :
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
