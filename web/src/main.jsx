import React from 'react';
import { createRoot } from 'react-dom/client';
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { msalConfig } from './authConfig';
import App from './App';
import './styles.css';

const msalInstance = new PublicClientApplication(msalConfig);

async function bootstrap() {
  await msalInstance.initialize();
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length) msalInstance.setActiveAccount(accounts[0]);
  msalInstance.addEventCallback((e) => {
    if (e.eventType === EventType.LOGIN_SUCCESS && e.payload?.account) {
      msalInstance.setActiveAccount(e.payload.account);
    }
  });

  createRoot(document.getElementById('root')).render(
    <MsalProvider instance={msalInstance}>
      <App msalInstance={msalInstance} />
    </MsalProvider>
  );
}

bootstrap();
