import { create } from 'zustand';
import type { SDKRateLimitInfo } from '../../shared/types';

interface RateLimitState {
  /** Rate limit notice for Claude sessions (tasks, roadmap, changelog, ...) */
  isSDKModalOpen: boolean;
  sdkRateLimitInfo: SDKRateLimitInfo | null;

  showSDKRateLimitModal: (info: SDKRateLimitInfo) => void;
  hideSDKRateLimitModal: () => void;
}

export const useRateLimitStore = create<RateLimitState>((set) => ({
  isSDKModalOpen: false,
  sdkRateLimitInfo: null,

  showSDKRateLimitModal: (info: SDKRateLimitInfo) => {
    set({ isSDKModalOpen: true, sdkRateLimitInfo: info });
  },

  hideSDKRateLimitModal: () => {
    set({ isSDKModalOpen: false });
  },
}));
