import SubNavigation from '../../components/SubNavigation.jsx';
import { IR_SECTIONS } from './irSections.js';

/** IR 投資情報的第二層導覽（總覽／股價與競品／財務營運／重大訊息與股利），與 PR 共用 SubNavigation。 */
export default function IRSubNavigation({ active, onChange }) {
  return <SubNavigation sections={IR_SECTIONS} active={active} onChange={onChange}
    prefix="ir" label="IR 投資情報子頁" />;
}
