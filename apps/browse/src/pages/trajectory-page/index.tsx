/**
 * TrajectoryPage —— /trajectory 与 /trajectory/:runId 的路由组件。
 *
 * 独立于 MainLayout（全宽，不渲染 wiki 侧边栏），因为轨迹页是独立的工作台。
 */

import { useParams } from 'react-router';
import { TrajectoryView } from '@/features/trajectory/TrajectoryView';

export default function TrajectoryPage() {
  const { runId } = useParams<{ runId?: string }>();

  return <TrajectoryView runId={runId} />;
}
