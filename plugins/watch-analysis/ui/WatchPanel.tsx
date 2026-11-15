/**
 * ui/WatchPanel — 「拉片分析」面板（WatchTab 的宿主包装）
 *
 * 为什么需要一个包装而不是直接把 WatchTab 挂到详情页：
 *   WatchTab 处理的是**某一集**（需要 `episode`），而详情页只知道"哪部番"。
 *   「选哪一集」是宿主的知识（本地番剧库里真实存在的文件），插件不该自己去扫盘。
 *   所以这里只负责：选集 → 把 `episode` + `videoFile` 交给 WatchTab。
 *
 * 依赖方向仍然是单向的：本组件只 import 同目录的 WatchTab，
 * 集列表由宿主通过 `episodes` prop 注入。
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Empty, Modal, Select, Space, Typography } from 'antd'
import WatchTab from './WatchTab'

export interface WatchPanelEpisode {
  /** 集号（来自本地番剧库的解析结果） */
  number: number
  /** 文件名，只用于选择器展示 */
  fileName: string
  /** 视频绝对路径（宿主拼好传进来；服务端也能自己解析，这里传是为了省一次扫描） */
  videoFile: string
}

export interface WatchPanelProps {
  open: boolean
  onClose: () => void
  /** `模板::标题` */
  animeKey: string
  title: string
  /** 本地番剧库里这一部已经下载到磁盘的集 */
  episodes: WatchPanelEpisode[]
  /** 一集都没有时给用户的话（通常是"去设置 → 本地绑定目录"） */
  emptyHint?: string
  /** 默认选中哪一集（一般是上次看到的那集） */
  initialEpisode?: number
}

const WatchPanel: React.FC<WatchPanelProps> = ({
  open,
  onClose,
  animeKey,
  title,
  episodes,
  emptyHint,
  initialEpisode,
}) => {
  const sorted = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes],
  )

  // 默认停在"上次看到的那集"，其次第一集
  const resolveDefault = () => {
    if (sorted.length === 0) return 1
    if (initialEpisode && sorted.some((ep) => ep.number === initialEpisode)) return initialEpisode
    return sorted[0].number
  }

  const [episode, setEpisode] = useState<number>(resolveDefault)

  // 每次打开重新对齐一次：换了一部番、或者新下了几集，不该沿用上一次的选择
  useEffect(() => {
    if (open) setEpisode(resolveDefault())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, animeKey, episodes])

  const current = sorted.find((ep) => ep.number === episode) ?? sorted[0]

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1080}
      destroyOnHidden
      title={
        <Space size={8}>
          <span>📽️ 拉片分析</span>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            {title}
          </Typography.Text>
        </Space>
      }
    >
      {sorted.length === 0 ? (
        <Empty
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>这部番还没有绑定本地视频</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {emptyHint ?? '去「设置 → 本地」添加番剧目录并绑定这部番，之后就能在这里逐集拉片。'}
              </Typography.Text>
            </Space>
          }
          style={{ padding: '40px 0' }}
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>选择集数</Typography.Text>
            <Select
              value={episode}
              style={{ minWidth: 260 }}
              options={sorted.map((ep) => ({
                value: ep.number,
                label: `第 ${ep.number} 集 · ${ep.fileName}`,
              }))}
              onChange={(value: number) => setEpisode(value)}
              showSearch
              optionFilterProp="label"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {sorted.length} 集可选
            </Typography.Text>
          </Space>

          {current ? (
            <WatchTab
              animeKey={animeKey}
              episode={current.number}
              title={`${title} · 第 ${current.number} 集`}
              videoFile={current.videoFile}
            />
          ) : (
            <Alert type="warning" showIcon message="这一集没有可用的视频文件" />
          )}
        </Space>
      )}
    </Modal>
  )
}

export default WatchPanel
export { WatchPanel }
