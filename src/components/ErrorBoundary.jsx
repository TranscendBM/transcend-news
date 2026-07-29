import React from 'react';

// 捕捉 render 錯誤，避免白/黑畫面
export default class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{ minHeight:'100vh', background:'#f5f6f8', color:'#b91c1c', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, padding:24, fontFamily:'sans-serif' }}>
        <p style={{ fontSize:18, fontWeight:'bold' }}>⚠ 程式載入錯誤</p>
        <p style={{ fontSize:13, color:'#64748b', maxWidth:480, textAlign:'center' }}>請按 F12 開啟 Console，將錯誤訊息截圖回報</p>
        <pre style={{ fontSize:11, color:'#475569', background:'#fff', border:'1px solid #e5e7eb', padding:12, borderRadius:8, maxWidth:600, overflow:'auto' }}>
          {String(this.state.error)}
        </pre>
      </div>
    );
    return this.props.children;
  }
}
