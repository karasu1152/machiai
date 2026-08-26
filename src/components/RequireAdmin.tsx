import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

// 管理者限定ルートのガード。RequireAuthの内側で使うこと。
export default function RequireAdmin() {
  const { loading, staff } = useAuth();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-neutral-400">…</div>;
  }
  if (!staff || staff.role !== 'admin') {
    return <Navigate to="/staff" replace />;
  }
  return <Outlet />;
}
