/**
 * Markdown 渲染
 *
 * 模型的回答天生是 Markdown（**加粗**、编号列表、表格），当纯文本渲染会直接露出
 * 星号和竖线 —— 所以这里得真渲染。用 react-markdown + remark-gfm：
 * 表格、删除线、任务列表这些都靠 gfm 插件，自己写解析器迟早会在嵌套列表上翻车。
 *
 * 两个必须处理的细节：
 *
 * 1) **链接不能导航整个应用**。Electron 里点一个普通 <a href> 会把窗口本身带走，
 *    界面就再也回不来了。所以一律加 target="_blank" —— 主进程的
 *    webContents.setWindowOpenHandler 会把它转给系统浏览器。
 *
 * 2) **缩进与字号按抽屉宽度调**。这是 400px 宽的窄栏，Markdown 默认的左缩进和
 *    段落间距会把内容挤得很碎，所以逐类覆盖了间距，用 CSS 变量保证跟主题一致。
 */

import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownProps {
  text: string;
}

const Markdown: React.FC<MarkdownProps> = memo(({ text }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      // 段落：窄栏里不需要大段间距
      p: ({ children }) => <p style={{ margin: '0 0 8px', lineHeight: 1.75 }}>{children}</p>,
      // 标题：默认的 h1/h2 在 400px 里太大，压到接近正文字号
      h1: ({ children }) => <div style={{ fontSize: 15, fontWeight: 700, margin: '12px 0 6px' }}>{children}</div>,
      h2: ({ children }) => <div style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 6px' }}>{children}</div>,
      h3: ({ children }) => <div style={{ fontSize: 13, fontWeight: 700, margin: '10px 0 5px' }}>{children}</div>,
      h4: ({ children }) => <div style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 5px' }}>{children}</div>,
      ul: ({ children }) => (
        <ul style={{ margin: '0 0 8px', paddingLeft: 20, lineHeight: 1.75 }}>{children}</ul>
      ),
      ol: ({ children }) => (
        <ol style={{ margin: '0 0 8px', paddingLeft: 20, lineHeight: 1.75 }}>{children}</ol>
      ),
      li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
      // 行内代码：用带底色的圆角小块，跟正文区分开
      code: ({ className, children, ...props }) => {
        const isBlock = typeof className === 'string' && className.startsWith('language-');
        if (isBlock) {
          return (
            <code
              className={className}
              style={{ fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace' }}
              {...props}
            >
              {children}
            </code>
          );
        }
        return (
          <code
            style={{
              fontSize: 12,
              padding: '1px 5px',
              borderRadius: 4,
              background: 'var(--bg-tertiary)',
              color: 'var(--brand-primary)',
              fontFamily: 'ui-monospace, Consolas, monospace',
            }}
            {...props}
          >
            {children}
          </code>
        );
      },
      pre: ({ children }) => (
        <pre style={{
          margin: '0 0 8px', padding: 8, borderRadius: 6,
          background: 'var(--bg-tertiary)', overflowX: 'auto',
          fontSize: 11, lineHeight: 1.6, maxHeight: 320,
        }}>
          {children}
        </pre>
      ),
      blockquote: ({ children }) => (
        <blockquote style={{
          margin: '0 0 8px', padding: '2px 10px',
          borderLeft: '3px solid var(--border-primary)',
          color: 'var(--text-secondary)',
        }}>
          {children}
        </blockquote>
      ),
      // 表格：模型很爱用它，但列一多就撑破窄栏，所以允许横向滚动
      table: ({ children }) => (
        <div style={{ overflowX: 'auto', margin: '0 0 8px' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.6 }}>{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th style={{
          border: '1px solid var(--border-primary)', padding: '4px 8px',
          background: 'var(--bg-tertiary)', textAlign: 'left', whiteSpace: 'nowrap',
        }}>
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td style={{ border: '1px solid var(--border-primary)', padding: '4px 8px' }}>{children}</td>
      ),
      hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--border-primary)', margin: '10px 0' }} />,
      a: ({ href, children }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--brand-primary)' }}
        >
          {children}
        </a>
      ),
      // 原文里出现的裸 HTML 一律当文本，不执行
      strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
    }}
  >
    {text}
  </ReactMarkdown>
));

Markdown.displayName = 'Markdown';

export default Markdown;
