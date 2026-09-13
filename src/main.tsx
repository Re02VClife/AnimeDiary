import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import { AnimeProvider } from '../context/AnimeContext';
import { seedCharacterTemplate, migrateCategoryLabels } from '../features/anime-data/template-service';
import App from './App';
import './index.css';

// dayjs 全局设置（必须早于任何日期组件渲染）：
// 1. zh-cn locale —— 否则 DatePicker 的月份面板是 Jan/Feb/Mar，与 antd 的 zh_CN 无关
// 2. customParseFormat —— 否则 dayjs(s, ['YYYY-MM'], true) 的第 2 个参数被静默忽略，
//    退化成 new Date(s) 的宽松解析："46138" 会被解析成 4613 年（日期面板翻到几百年后）
dayjs.extend(customParseFormat);
dayjs.locale('zh-cn');

// 内置模板种子：必须早于任何组件渲染（App 的 loadTemplates useMemo 只求值一次）
seedCharacterTemplate();
// 迁移：给早期版本创建的空分类配置补上默认分类标签（否则顶栏没有 在看/想看/搁置/看过/抛弃）
migrateCategoryLabels();

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
