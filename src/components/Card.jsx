export default function Card({ title, icon, children, className = '', actions }) {
  return (
    <div className={`bg-gray-900 rounded-2xl border border-gray-700/60 p-4 ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-base font-semibold text-gray-200 flex items-center gap-2"><span>{icon}</span>{title}</h3>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
