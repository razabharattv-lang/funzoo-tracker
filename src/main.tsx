import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class StudioErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unexpected rendering error occurred.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Studio UI boundary caught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F4F6F9] text-[#0F172A] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border-2 border-[#FF1744] bg-white p-6 space-y-3 text-center">
            <h1 className="text-base font-extrabold text-[#0F172A]">
              Studio Recovered From an Unexpected Error
            </h1>
            <p className="text-xs font-semibold text-[#64748B] break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="inline-flex items-center justify-center px-4 py-2 rounded-xl border-2 border-[#3D5AFE] bg-[#3D5AFE] text-white text-xs font-extrabold cursor-pointer"
            >
              Reload Studio Workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <StudioErrorBoundary>
        <App />
      </StudioErrorBoundary>
    </StrictMode>
  );
}

