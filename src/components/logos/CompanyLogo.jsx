import TranscendMark from './TranscendMark.jsx';
import { BRAND } from '../../utils/news.js';

// IR 股價卡：各家競品 logo 圖檔（創見自己用 TranscendMark，不在此列）
export const COMPANY_LOGO_SRC = {
  '3260': '/logos/adata.png',
  '5289': '/logos/innodisk.png',
  '4967': '/logos/teamgroup.webp',
  '8271': '/logos/apacer.png',
  '4973': '/logos/silicon-power.webp',
};

export default function CompanyLogo({ code, height = 20 }) {
  if (code === '2451') return <TranscendMark height={height} fill={BRAND} />;
  const src = COMPANY_LOGO_SRC[code];
  if (!src) return null;
  return <img src={src} alt="" style={{ height, width: 'auto', display: 'block', objectFit: 'contain' }} />;
}
