import { BRAND } from '../utils/news.js';

export default function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${active ? 'text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'}`}
      style={active ? { background: BRAND } : {}}>
      {children}
    </button>
  );
}
