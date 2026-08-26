import { Routes, Route } from 'react-router-dom';
import KioskPage from './pages/kiosk/KioskPage';
import GuestStatusPage from './pages/guest/GuestStatusPage';
import SignagePage from './pages/signage/SignagePage';
import LoginPage from './pages/staff/LoginPage';
import DashboardPage from './pages/staff/DashboardPage';
import QueueManagePage from './pages/staff/QueueManagePage';
import AnalyticsPage from './pages/staff/AnalyticsPage';
import QueuesAdminPage from './pages/admin/QueuesAdminPage';
import PrintersAdminPage from './pages/admin/PrintersAdminPage';
import StaffAdminPage from './pages/admin/StaffAdminPage';

// NOTE: RequireAuth / RequireAdmin は Phase 3 で実装する。
// 現時点ではプロトタイプとして全ルートを素通りさせている。
export default function App() {
  return (
    <Routes>
      <Route path="/k/:tenantSlug" element={<KioskPage />} />
      <Route path="/t/:token" element={<GuestStatusPage />} />
      <Route path="/s/:tenantSlug" element={<SignagePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/staff" element={<DashboardPage />} />
      <Route path="/staff/q/:queueId" element={<QueueManagePage />} />
      <Route path="/staff/analytics" element={<AnalyticsPage />} />
      <Route path="/admin/queues" element={<QueuesAdminPage />} />
      <Route path="/admin/printers" element={<PrintersAdminPage />} />
      <Route path="/admin/staff" element={<StaffAdminPage />} />
    </Routes>
  );
}
