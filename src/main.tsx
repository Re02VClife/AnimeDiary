import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import { AnimeProvider } from '../context/AnimeContext';
import { seedCharacterTemplate } from '../features/anime-data/template-service';
import App from './App';
import './index.css';

// 内置模板种子：必须早于任何组件渲染（App 的 loadTemplates useMemo 只求值一次）
seedCharacterTemplate();

/**
 * 内部组件：从 ThemeContext 读取当前主题配置，传给 Ant Design ConfigProvider
 */
const AppShell: React.FC = () => {
  const { state, colors } = useTheme();

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm:
          state.themeMode === 'dark'
            ? theme.darkAlgorithm
            : theme.defaultAlgorithm,
        token: {
          colorPrimary: colors.brandPrimary,
          colorBgBase: colors.bgPrimary,
          colorBgContainer: colors.bgSecondary,
          colorBgElevated: colors.bgTertiary,
          colorBorder: colors.borderPrimary,
          colorText: colors.textPrimary,
          colorTextSecondary: colors.textSecondary,
          borderRadius: 8,
          fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif`,
        },
      }}
    >
      <AnimeProvider>
        <App />
      </AnimeProvider>
    </ConfigProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  </React.StrictMode>
);
