import { createContext, useCallback, useContext, useMemo, useReducer, useRef, useState } from 'react';

// 跨子頁保存 PR 媒體戰情的畫面狀態（搜尋、媒體、情緒、品牌、期間、展開的主題…）。
//
// 切換子頁時只渲染目前的子頁，其他子頁的元件會卸載；元件自己的 useState 會跟著消失，
// 所以這些狀態改放在 PRTab 這一層的 store，切回來時還在。這裡只存「畫面狀態」，
// 不存任何 Firestore 資料（資料與監聽器都在 App 層，切換子頁不會重抓、也不會重建監聽）。

const PanelStateContext = createContext(null);

function reducer(state, action) {
  const has = action.key in state;
  const previous = has ? state[action.key] : action.getInitial();
  const next = typeof action.value === 'function' ? action.value(previous) : action.value;
  return has && Object.is(previous, next) ? state : { ...state, [action.key]: next };
}

export function PanelStateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, {});
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <PanelStateContext.Provider value={value}>{children}</PanelStateContext.Provider>;
}

/**
 * 用法同 useState，但狀態放在 PanelStateProvider：切換子頁後仍會保留。
 * 沒有被 PanelStateProvider 包住時（例如單獨測試某個元件）退回一般的 useState。
 * initial 可以是值或函式；函式最多只在「需要用到初始值」時呼叫一次。
 */
export function usePanelState(key, initial) {
  const ctx = useContext(PanelStateContext);
  const cache = useRef(null);
  const resolveInitial = useCallback(() => {
    if (!cache.current) cache.current = { value: typeof initial === 'function' ? initial() : initial };
    return cache.current.value;
  }, [initial]);

  // 沒有 provider 時才需要本地 state；有 provider 時不要白白呼叫一次初始值函式
  const [local, setLocal] = useState(() => (ctx ? undefined : resolveInitial()));

  const dispatch = ctx ? ctx.dispatch : null;
  const setShared = useCallback(
    value => dispatch({ key, value, getInitial: resolveInitial }),
    [dispatch, key, resolveInitial]);

  if (!ctx) return [local, setLocal];
  return [key in ctx.state ? ctx.state[key] : resolveInitial(), setShared];
}
