import React from "react";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("ui_render_failed", { message: error.message, componentStack: info.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <strong>Không thể hiển thị cockpit</strong>
        <span>{this.state.error.message}</span>
        <button onClick={() => window.location.reload()}>Tải lại ứng dụng</button>
      </main>
    );
  }
}
