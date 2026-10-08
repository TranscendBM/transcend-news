/* global File, sessionStorage */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import MediaExposureUpload, { UPLOAD_ENDPOINT } from './MediaExposureUpload.jsx';

const CHECK_RESULT = {
  ok: true, mode: 'check', rowsSeen: 5, validRows: 4, uniqueRecords: 3, duplicateRows: 1,
  invalidRows: [], uniqueMedia: 2, exposureTypes: { online: 3 },
  byMonth: { '2026-08': 2, '2026-09': 1 }, newRecords: 2, existingRecords: 1,
};
const INVALID = [{ file: 'a.xlsx', sheet: '08', row: 7, reason: '缺少日期、媒體、新聞標題' }];

let fetchMock;
function jsonResponse(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

function pickFile(name = 'Media exposure_08.xlsx') {
  const input = screen.getByLabelText('選擇 Excel 檔案');
  const file = new File(['PKfake'], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

function typePasscode(value = 'secret-code') {
  fireEvent.change(screen.getByLabelText('上傳通行碼'), { target: { value } });
}

function sentBody(callIndex = 0) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('MediaExposureUpload', () => {
  it('檢查按鈕在選擇檔案前是停用的；沒填通行碼會提示而不送出請求', () => {
    render(<MediaExposureUpload />);
    expect(screen.getByText('① 檢查檔案').disabled).toBe(true);
    pickFile();
    fireEvent.click(screen.getByText('① 檢查檔案'));
    expect(screen.getByRole('alert').textContent).toContain('請輸入上傳通行碼');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('檢查：POST 到 /api/media-exposure（mode=check），顯示筆數、各月與是否已存在', async () => {
    fetchMock.mockReturnValue(jsonResponse(200, CHECK_RESULT));
    render(<MediaExposureUpload />);
    pickFile(); typePasscode();
    fireEvent.click(screen.getByText('① 檢查檔案'));

    expect(await screen.findByText('② 確認匯入 3 筆')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe(UPLOAD_ENDPOINT);
    const body = sentBody();
    expect(body.mode).toBe('check');
    expect(body.passcode).toBe('secret-code');
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe('Media exposure_08.xlsx');
    expect(body.files[0].data.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('approveSkippingInvalid');

    expect(screen.getByText('2 / 1')).toBeTruthy();          // 新增 / 已存在
    expect(screen.getByText(/2026-08（2）、2026-09（1）/)).toBeTruthy();
  });

  it('沒有無效列時，確認匯入不需要勾選就能按；匯入成功後顯示筆數', async () => {
    const onImported = vi.fn();
    fetchMock
      .mockReturnValueOnce(jsonResponse(200, CHECK_RESULT))
      .mockReturnValueOnce(jsonResponse(200, { ...CHECK_RESULT, mode: 'commit', written: 3 }));
    render(<MediaExposureUpload onImported={onImported} />);
    pickFile(); typePasscode();
    fireEvent.click(screen.getByText('① 檢查檔案'));
    fireEvent.click(await screen.findByText('② 確認匯入 3 筆'));

    expect((await screen.findByRole('status')).textContent).toContain('已匯入 3 筆');
    expect(sentBody(1).mode).toBe('commit');
    expect(sentBody(1)).not.toHaveProperty('approveSkippingInvalid');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('有無效列：列出位置，必須勾選確認略過才能匯入，且送出的略過數與無效列數一致', async () => {
    fetchMock
      .mockReturnValueOnce(jsonResponse(200, { ...CHECK_RESULT, invalidRows: INVALID }))
      .mockReturnValueOnce(jsonResponse(200, { ...CHECK_RESULT, mode: 'commit', written: 3, invalidRows: INVALID }));
    render(<MediaExposureUpload />);
    pickFile(); typePasscode();
    fireEvent.click(screen.getByText('① 檢查檔案'));

    const importBtn = await screen.findByText('② 確認匯入 3 筆');
    expect(screen.getByText(/第 7 列：缺少日期、媒體、新聞標題/)).toBeTruthy();
    expect(importBtn.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/我確認略過這 1 列/));
    expect(importBtn.disabled).toBe(false);
    fireEvent.click(importBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody(1).approveSkippingInvalid).toBe(1);
  });

  it('通行碼錯誤或伺服器拒絕時顯示伺服器回傳的錯誤訊息，不會進入匯入步驟', async () => {
    fetchMock.mockReturnValue(jsonResponse(403, { ok: false, error: '上傳通行碼不正確' }));
    render(<MediaExposureUpload />);
    pickFile(); typePasscode('wrong');
    fireEvent.click(screen.getByText('① 檢查檔案'));

    expect((await screen.findByRole('alert')).textContent).toContain('上傳通行碼不正確');
    expect(screen.queryByText(/確認匯入/)).toBeNull();
  });

  it('連線失敗時顯示網路錯誤', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<MediaExposureUpload />);
    pickFile(); typePasscode();
    fireEvent.click(screen.getByText('① 檢查檔案'));
    expect((await screen.findByRole('alert')).textContent).toContain('無法連線到伺服器');
  });

  it('成功後記住通行碼（只在本次瀏覽期間），下次打開不用重打', async () => {
    fetchMock.mockReturnValue(jsonResponse(200, CHECK_RESULT));
    const { unmount } = render(<MediaExposureUpload />);
    pickFile(); typePasscode('remember-me');
    fireEvent.click(screen.getByText('① 檢查檔案'));
    await screen.findByText('② 確認匯入 3 筆');
    unmount();

    render(<MediaExposureUpload />);
    expect(screen.getByLabelText('上傳通行碼').value).toBe('remember-me');
  });

  it('只接受 .xlsx：選到其他格式會被略過並提示', () => {
    render(<MediaExposureUpload />);
    const input = screen.getByLabelText('選擇 Excel 檔案');
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.csv', { type: 'text/csv' })] } });
    expect(screen.getByRole('alert').textContent).toContain('只接受 .xlsx');
    expect(screen.getByText('① 檢查檔案').disabled).toBe(true);
  });
});
