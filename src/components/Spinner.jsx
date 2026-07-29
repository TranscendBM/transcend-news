export default function Spinner({ size = 'sm' }) {
  const s = size === 'lg' ? 'w-8 h-8 border-[3px]' : 'w-4 h-4 border-2';
  return <div className={`${s} border-gray-700 border-t-red-500 rounded-full spin`} />;
}
