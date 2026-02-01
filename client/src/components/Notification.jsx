function Notification({ message, type, onClose }) {
  return (
    <div className={`notification ${type}`}>
      <p>{message}</p>
    </div>
  );
}

export default Notification;

