import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Chat } from './components/Chat';
import { Gallery } from './components/Gallery';
import { Sidebar } from './components/Sidebar';
import { ConfigDropdown } from './components/ConfigDropdown';
import { AppProvider } from './context/AppContext';
import './App.css';

function AppLayout() {
  return (
    <div className="app">
      <Sidebar />
      <div className="main-content">
        <div className="top-bar">
          <ConfigDropdown />
        </div>
        <Routes>
          <Route path="/" element={<Gallery />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <AppLayout />
      </AppProvider>
    </BrowserRouter>
  );
}

export default App;
