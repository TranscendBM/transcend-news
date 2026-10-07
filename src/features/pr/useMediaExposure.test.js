import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useMediaExposure } from './useMediaExposure.js';

const unsubscribe = vi.fn();
const onSnapshot = vi.fn(() => unsubscribe);

vi.mock('../../services/firebase.js', () => ({
  getDb: () => ({ __fake: 'db' }),
  collection: (db, name) => ({ __marker: 'collection', name }),
  orderBy: (...args) => ({ __marker: 'orderBy', args }),
  limit: (...args) => ({ __marker: 'limit', args }),
  query: (...constraints) => ({ __marker: 'query', constraints }),
  onSnapshot: (...args) => onSnapshot(...args),
}));

beforeEach(() => {
  onSnapshot.mockClear();
  unsubscribe.mockClear();
});

describe('useMediaExposure', () => {
  it('queries only the sanitized public collection, newest first, with a bounded limit', async () => {
    renderHook(() => useMediaExposure());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));

    const [q] = onSnapshot.mock.calls[0];
    expect(q.constraints[0]).toEqual({ __marker: 'collection', name: 'media_exposure' });
    expect(q.constraints[1]).toEqual({ __marker: 'orderBy', args: ['exposureDate', 'desc'] });
    expect(q.constraints[2]).toEqual({ __marker: 'limit', args: [1000] });
    expect(JSON.stringify(q)).not.toContain('media_exposure_private');
  });

  it('publishes records and exposes a clear error state', async () => {
    const { result } = renderHook(() => useMediaExposure());
    const [, onNext, onError] = onSnapshot.mock.calls[0];

    await act(async () => {
      onNext({ docs: [{ id: 'exp_1', data: () => ({ title: '人工曝光' }) }] });
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.records).toEqual([{ id: 'exp_1', title: '人工曝光' }]);

    await act(async () => onError(new Error('down')));
    expect(result.current.status).toBe('error');
  });

  it('does not create a listener while disabled', () => {
    const { result } = renderHook(() => useMediaExposure({ enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('unsubscribes when leaving the PR tab', async () => {
    const { rerender } = renderHook(
      ({ enabled }) => useMediaExposure({ enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

