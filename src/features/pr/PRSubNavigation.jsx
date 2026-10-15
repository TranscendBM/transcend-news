import SubNavigation from '../../components/SubNavigation.jsx';
import { PR_SECTIONS } from './prSections.js';

/** PR 媒體戰情的第二層導覽（總覽／新聞監測／競品動態／曝光成效），實作見共用的 SubNavigation。 */
export default function PRSubNavigation({ active, onChange }) {
  return <SubNavigation sections={PR_SECTIONS} active={active} onChange={onChange}
    prefix="pr" label="PR 媒體戰情子頁" />;
}
