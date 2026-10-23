import { Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from '@/components/Toaster';
import { DialogProvider } from '@/components/dialogs/DialogProvider';
import { AgentPage } from '@/features/agent/AgentPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { IncidentDetailPage } from '@/features/incidents/IncidentDetailPage';
import { IncidentsPage } from '@/features/incidents/IncidentsPage';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { LabPage } from '@/features/lab/LabPage';
import { LoadTestDetailPage } from '@/features/loadtest/LoadTestDetailPage';
import { GuidePage } from '@/features/guide/GuidePage';
import { ComparePage } from '@/features/loadtest/ComparePage';
import { StandardsPage } from '@/features/standards/StandardsPage';
import { PlaygroundPage } from '@/features/playground/PlaygroundPage';
import { WebChecksPage } from '@/features/webchecks/WebChecksPage';
import { LoadTestsPage } from '@/features/loadtest/LoadTestsPage';
import { ServerDocPage } from '@/features/inventory/ServerDocPage';
import { MonitorPage } from '@/features/monitor/MonitorPage';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { ServersPage } from '@/features/servers/ServersPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { RunPage } from '@/features/setup/RunPage';
import { SetupPage } from '@/features/setup/SetupPage';
import { TokensPage } from '@/features/tokens/TokensPage';
import { AppShell } from '@/layout/AppShell';

export function App() {
  return (
    <DialogProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Navigate to="/ringkasan" replace />} />
          <Route path="ringkasan" element={<OverviewPage />} />
          <Route path="insiden" element={<IncidentsPage />} />
          <Route path="insiden/:id" element={<IncidentDetailPage />} />
          <Route path="inventaris" element={<InventoryPage />} />
          <Route path="inventaris/:id" element={<ServerDocPage />} />
          <Route path="arsitektur" element={<LabPage />} />
          <Route path="panduan" element={<GuidePage />} />
<Route path="standar" element={<StandardsPage />} />
<Route path="playground" element={<PlaygroundPage />} />
<Route path="layanan" element={<WebChecksPage />} />
<Route path="uji-beban" element={<LoadTestsPage />} />
          <Route path="uji-beban/banding" element={<ComparePage />} />
<Route path="uji-beban/:id" element={<LoadTestDetailPage />} />
          <Route path="server" element={<ServersPage />} />
          <Route path="agen/:id" element={<AgentPage />} />
          <Route path="setup" element={<SetupPage />} />
          <Route path="setup/:id" element={<RunPage />} />
          <Route path="monitor" element={<MonitorPage />} />
          <Route path="monitor/:id" element={<MonitorPage />} />
          <Route path="token" element={<TokensPage />} />
          <Route path="pengaturan" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/ringkasan" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </DialogProvider>
  );
}
