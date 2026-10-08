import React from 'react';
import './styles/globals.css';
// Mocha Glass: the motion (jelly, press, count-ups, pause, theme shockwave) and the
// pickers (glass calendar for date/month/time fields, glass combobox for input[list],
// file drop zones). Both act on everything inside .mg, which is the <body>.
import { installMotion } from './styles/mocha/motion.js';
import './styles/mocha/pickers.js';
import SceneBackdrop from './components/SceneBackdrop.jsx';
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

// .mg on <body> rather than #root, so Radix portals (dialogs, menus) and the
// pickers' own pop-ups, all appended to <body>, are inside it too.
document.body.classList.add('mg');
installMotion();

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
 * Staff pick: the switch is in the rail and the choice is remembered per
 * browser. Clients pick too (Wave 9): the acceptance page and the portal
 * follow the theme, light by default, with their own switch. Their choice
 * is kept apart from staff's (its own storage key, read by theme-init.js),
 * so a client is never handed the dark mode of whoever last used this
 * browser for the tracker.
 *
 * The theme is written as both the .dark class (Tailwind, shadcn) and
 * data-theme (Mocha Glass).
 */
const Theme = ({ children, client }) => (
  <ThemeProvider attribute={['class', 'data-theme']} defaultTheme="light" enableSystem storageKey={client ? 'cetizion.client-theme' : 'cetizion.theme'}>
    {children}
  </ThemeProvider>
);

createRoot(document.getElementById('root')).render(
  acceptToken ? <React.StrictMode><Theme client><SceneBackdrop /><AcceptQuotation token={acceptToken} /></Theme></React.StrictMode> :
  questionnaireToken ? <React.StrictMode><Theme client><SceneBackdrop /><FillQuestionnaire token={questionnaireToken} /></Theme></React.StrictMode> :
  portalPath ? <Theme client><SceneBackdrop /><Portal loginToken={portalPath[1]} /></Theme> :
  <React.StrictMode>
    <Theme>
      <SceneBackdrop />
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
