import React from 'react';
import './styles/globals.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from 'next-themes';
import App from './App.jsx';
import { ToastProvider } from './components/ui.jsx';
import AuthGate from './components/AuthGate.jsx';
import { AuthProvider } from './lib/auth.jsx';
import AcceptQuotation from './pages/AcceptQuotation.jsx';
import Portal from './pages/Portal.jsx';
import FillQuestionnaire from './pages/FillQuestionnaire.jsx';
import { startErrorReporting } from './lib/errorReporting.js';
import { EnvironmentBanner } from './components/EnvironmentBanner.jsx';

startErrorReporting();

// A client's acceptance link (#53) opens outside the signed-in app.
const acceptToken = window.location.pathname.match(/^\/accept\/([A-Za-z0-9_-]+)$/)?.[1];
// A client's service questionnaire link (#208), outside the signed-in app too.
const questionnaireToken = window.location.pathname.match(/^\/q\/([A-Za-z0-9_-]+)\/?$/)?.[1];
// The client portal (#47) is its own small app with its own sign-in.
const portalPath = window.location.pathname.match(/^\/portal(?:\/login\/([A-Za-z0-9_-]+))?\/?$/);

// Outside the app's own root, so every page shows it, the client-facing ones included.
const bannerRoot = document.createElement('div');
document.body.prepend(bannerRoot);
createRoot(bannerRoot).render(<EnvironmentBanner />);

/**
 * The theme, and who gets a choice about it.
 *
 * Staff pick: the toggle is in the sidebar footer and the choice is
 * remembered per browser. Clients do not: the acceptance page and the
 * portal are branded surfaces a client sees once, from a link, and C18
 * draws them dark — so they are pinned dark rather than following a
 * setting belonging to whoever last used this browser.
 */
const Theme = ({ children, forced }) => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem storageKey="cetizion.theme" forcedTheme={forced}>
    {children}
  </ThemeProvider>
);

createRoot(document.getElementById('root')).render(
  acceptToken ? <React.StrictMode><Theme forced="dark"><AcceptQuotation token={acceptToken} /></Theme></React.StrictMode> :
  questionnaireToken ? <React.StrictMode><Theme forced="dark"><FillQuestionnaire token={questionnaireToken} /></Theme></React.StrictMode> :
  portalPath ? <Theme forced="dark"><Portal loginToken={portalPath[1]} /></Theme> :
  <React.StrictMode>
    <Theme>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <AuthGate>
              <App />
            </AuthGate>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </Theme>
  </React.StrictMode>
);
