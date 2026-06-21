import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AnimeProvider } from '../context/AnimeContext';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#fb7299',
          colorBgBase: '#0d1117',
          colorBgContainer: '#161b22',
          colorBgElevated: '#1c2128',
          colorBorder: '#30363d',
          colorText: '#e6edf3',
          colorTextSecondary: '#8b949e',
          borderRadius: 8,
          fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif`,
        },
      }}
    >
      <AnimeProvider>
        <App />
      </AnimeProvider>
    </ConfigProvider>
  </React.StrictMode>
);
