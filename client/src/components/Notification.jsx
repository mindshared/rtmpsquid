import { useEffect } from 'react';

function Notification({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className={`notification ${type}`} role="status">
      <p>{message}</p>
      <button className="notification-close" onClick={onClose} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

export default Notification;
