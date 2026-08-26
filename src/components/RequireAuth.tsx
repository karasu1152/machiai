import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

// ログイン必須ルートのガード。未ログイン、またはstaffテーブルに
// 有効な行がなければ /login に飛ばす。(08_開発指示プロンプト.md ルーティング参照)
export default function RequireAuth() {
  const { loading, session, staff } = useAuth();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-neutral-400">…</div>;
  }
  if (!session || !staff || !staff.is_active) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
