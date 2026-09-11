'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import clsx from 'clsx';
import { Insets } from '@/types/misc';
import { RsvpState, RSVPController } from '@/services/rsvp';
import { containsCJK, isRTLText } from '@/services/rsvp/utils';
import { useThemeStore } from '@/store/themeStore';
import { useSettingsStore } from '@/store/settingsStore';
import { TOCItem } from '@/libs/document';
import {
  IoClose,
  IoPlay,
  IoPause,
  IoPlaySkipBack,
  IoRemove,
  IoAdd,
  IoChevronDown,
  IoSettingsSharp,
  IoSearch,
  IoVolumeHigh,
  IoVolumeMediumOutline,
  IoLockClosed,
} from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import { getPopupPosition, Position } from '@/utils/sel';
import { Overlay } from '@/components/Overlay';
import DictionarySheet from '@/app/reader/components/annotator/DictionarySheet';
import DictionaryPopup from '@/app/reader/components/annotator/DictionaryPopup';
import TTSFollowIndicator, { TtsSyncStatus } from '@/app/reader/components/tts/TTSFollowIndicator';
import { Toggle } from '@/components/primitives/toggle';

interface FlatChapter {
  label: string;
  href: string;
  level: number;
}

interface ContextWordProps {
  text: string;
  wordIndex: number;
  isCurrent: boolean;
  currentRef?: React.Ref<HTMLSpanElement>;
  orpColor?: string;
}

const ContextWord = React.memo(function ContextWord({
  text,
  wordIndex,
  isCurrent,
  currentRef,
  orpColor,
}: ContextWordProps) {
  // Words are click-to-seek but are NOT individually tab-focusable/announced
  // (#D3): ~230 windowed words would otherwise be 230 tab stops and 230 SR
  // "button" announcements. The panel stays a single selectable/clickable
  // region; `data-rsvp-word-clickable` marks a seek target for the delegated
  // click handler without exposing per-word roles.
  return (
    <span
      ref={currentRef}
      data-rsvp-word-button=''
      data-rsvp-word-index={wordIndex}
      data-rsvp-word-clickable={isCurrent ? undefined : ''}
      className={isCurrent ? undefined : 'cursor-pointer opacity-70 hover:opacity-100'}
      style={isCurrent && orpColor ? { color: orpColor } : undefined}
    >
      {text}{' '}
    </span>
  );
});

// Display settings
const FONT_SIZE_OPTIONS = [1.25, 1.5, 1.875, 2.25, 3, 3.75, 4.25, 5, 6, 8];
const DEFAULT_FONT_SIZE_INDEX = 4;
const ORP_COLOR_OPTIONS = ['', '#EF4444', '#3B82F6', '#22C55E', '#F97316', '#A855F7'];
const STORAGE_KEY_FONT_SIZE = 'readest_rsvp_fontsize';
const STORAGE_KEY_ORP_COLOR = 'readest_rsvp_orp_color';
const STORAGE_KEY_CONTEXT = 'readest_rsvp_context';
const STORAGE_KEY_HIGHLIGHT_WORD = 'readest_rsvp_cjk_highlight_word';

// Context panel windowing — long sections (e.g. AZW3 chapters with 40k+ words)
// would otherwise render tens of thousands of <span> elements and freeze the UI
// for many seconds on each section load.
const CONTEXT_CHUNK_SIZE = 50;
// The window re-centres every CONTEXT_CHUNK_SIZE words, so a small look-ahead is
// plenty for scrolling while keeping the initial mount cheap (the panel renders
// one component per word — large windows cost hundreds of nodes on first paint,
// which is a noticeable load stall on mobile).
const CONTEXT_WINDOW_BEFORE = 60;
const CONTEXT_WINDOW_AFTER = 120;

// TTS rate options for the overlay's rate picker (decision 6) — mirrors the
// 0.5–3.0 range the TTS panel slider clamps to, in 0.25 steps.
const TTS_RATE_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];

// Dictionary lookup popup sizing (mirrors the reader's Annotator popup).
const DICT_POPUP_PADDING = 10;
const DICT_POPUP_MAX_WIDTH = 480;
const DICT_POPUP_MAX_HEIGHT = 360;

interface RSVPOverlayProps {
  gridInsets: Insets;
  controller: RSVPController;
  chapters: TOCItem[];
  currentChapterHref: string | null;
  /**
   * Resolved CSS font-family for the displayed word, mirroring the reader's
   * font face/family settings. When undefined, the word keeps the monospace
   * fallback. See getBaseFontFamily in utils/style.
   */
  fontFamily?: string;
  /** Book language, used to pick dictionary providers for context lookups. */
  lang?: string;
  /**
   * Whether the book reads right-to-left (from the reader's view settings).
   * Drives RTL mirroring of the whole overlay — header, controls, and the
   * right-aligned RTL context. When omitted, direction is inferred from `lang`
   * or sampled from the text.
   */
  rtl?: boolean;
  /** Derived TTS-sync status driving the "following audio" indicator (#3235). */
  ttsSyncStatus?: TtsSyncStatus;
  /** True when following is paced by the estimator (non-Edge sentence sync). */
  estimated?: boolean;
  /** True when TTS audio is engaged (playing/paused) — drives the audio toggle. */
  ttsActive?: boolean;
  /** True when TTS is actively playing (vs paused) — drives the transport icon. */
  ttsPlaying?: boolean;
  /** Current TTS playback rate, shown selected in the rate picker (decision 6). */
  ttsRate?: number;
  /** Toggle TTS audio: start from the current word, or stop when engaged. */
  onToggleTtsAudio?: () => void;
  /** Pause/resume TTS — the transport play/pause maps here while read-along is on. */
  onToggleTtsPlay?: () => void;
  /** Set the TTS rate (one-shot) when the WPM control is TTS-driven. */
  onSetTtsRate?: (rate: number) => void;
  /** Re-engage following after a manual nav decoupled it (indicator action). */
  onResumeTtsFollow?: () => void;
  onClose: () => void;
  onChapterSelect: (href: string) => void;
  onRequestNextPage: () => void;
  /** Opens the dictionary management settings from the lookup header gear. */
  onManageDictionary?: () => void;
}

const RSVPOverlay: React.FC<RSVPOverlayProps> = ({
  gridInsets,
  controller,
  chapters,
  currentChapterHref,
  fontFamily,
  lang,
  rtl,
  ttsSyncStatus = 'idle',
  estimated = false,
  ttsActive = false,
  ttsPlaying = false,
  ttsRate = 1,
  onToggleTtsAudio,
  onToggleTtsPlay,
  onSetTtsRate,
  onResumeTtsFollow,
  onClose,
  onChapterSelect,
  onRequestNextPage,
  onManageDictionary,
}) => {
  const _ = useTranslation();
  const { themeCode, isDarkMode: _isDarkMode } = useThemeStore();
  const isSettingsDialogOpen = useSettingsStore((s) => s.isSettingsDialogOpen);
  const [state, setState] = useState<RsvpState>(controller.currentState);
  const currentWord = controller.currentDisplayWord;
  const currentChunk = controller.currentDisplayChunk;
  const isChunk = currentChunk.length > 1;
  // Direction is applied per word in the chunk render (#C7): flipping the whole
  // chunk RTL when only one word is RTL reverses Latin reading order.
  // Spritz-style fixation ticks above and below the ORP letter. In a chunk they
  // appear once, on the longest word, to anchor the eye without clutter.
  const longestChunkIdx = isChunk
    ? currentChunk.reduce(
        (best, w, i) => (w.text.length > (currentChunk[best]?.text.length ?? 0) ? i : best),
        0,
      )
    : 0;
  const orpTicks = (
    <>
      <span
        aria-hidden
        className='pointer-events-none absolute bottom-full left-1/2 h-[0.22em] w-px -translate-x-1/2 bg-current opacity-50'
      />
      <span
        aria-hidden
        className='pointer-events-none absolute top-full left-1/2 h-[0.22em] w-px -translate-x-1/2 bg-current opacity-50'
      />
    </>
  );
  // The transport (center) play/pause controls TTS while read-along is engaged,
  // otherwise RSVP's own timer (#3235). A ref keeps the latest closure so the
  // capture-phase keyboard/tap effects don't need it in their dep arrays.
  const transportToggleRef = useRef<() => void>(() => {});
  transportToggleRef.current = () => {
    if (ttsActive && onToggleTtsPlay) onToggleTtsPlay();
    else controller.togglePlayPause();
  };
  const transportPlaying = ttsActive ? ttsPlaying : state.playing;
  const [countdown, setCountdown] = useState<number | null>(controller.currentCountdown);
  const [showChapterDropdown, setShowChapterDropdown] = useState(false);
  const chapterDropdownRef = useRef<HTMLDivElement>(null);
  const [showRateDropdown, setShowRateDropdown] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_CONTEXT) === '1';
    } catch {
      return false;
    }
  });
  const [fontSizeIndex, setFontSizeIndex] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_FONT_SIZE);
      if (saved !== null) {
        const idx = parseInt(saved, 10);
        if (idx >= 0 && idx < FONT_SIZE_OPTIONS.length) return idx;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_FONT_SIZE_INDEX;
  });
  const [orpColorIndex, setOrpColorIndex] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ORP_COLOR);
      if (saved !== null) {
        const idx = parseInt(saved, 10);
        if (idx >= 0 && idx < ORP_COLOR_OPTIONS.length) return idx;
      }
    } catch {
      /* ignore */
    }
    return 0;
  });
  const [highlightWholeWord, setHighlightWholeWord] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_HIGHLIGHT_WORD) === '1';
    } catch {
      return false;
    }
  });
  const contextWordRef = useRef<HTMLSpanElement>(null);
  const contextPanelRef = useRef<HTMLDivElement>(null);
  const wordDisplayRef = useRef<HTMLDivElement>(null);
  // Dialog root (#D2): full-screen modal surface; we move initial focus here and
  // contain Tab within it so keyboard/SR users don't land "behind" the overlay.
  const overlayRootRef = useRef<HTMLDivElement>(null);
  // Shrink-to-fit for long focal words/chunks (#C1). URLs and compounds (esp.
  // from the RSS path) or large font sizes would otherwise overflow the
  // viewport on both sides of the ORP. We measure the word content's natural
  // width against the available width and scale it down to fit; scaling around
  // the centre preserves the ORP anchor for the split/whole/chunk layouts.
  const wordMeasureRef = useRef<HTMLDivElement>(null);
  const [wordScale, setWordScale] = useState(1);
  // Dictionary lookup from a context-panel selection (#4475). `lookup` is the
  // pending selection (drives the "Look up" pill); `dict` holds the resolved
  // word + popup placement once the dictionary is open.
  const [lookup, setLookup] = useState<{
    text: string;
    range: Range;
    left: number;
    top: number;
  } | null>(null);
  const [dict, setDict] = useState<{
    word: string;
    position: Position;
    trianglePosition: Position;
  } | null>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const touchStartTime = useRef(0);
  const holdSlowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdSlowActive = useRef(false);
  const SWIPE_THRESHOLD = 50;
  const TAP_THRESHOLD = 10;

  // Flatten chapters for dropdown
  const flatChapters = useMemo(() => {
    const flatten = (items: TOCItem[], level = 0): FlatChapter[] => {
      const result: FlatChapter[] = [];
      for (const item of items) {
        result.push({ label: item.label || '', href: item.href || '', level });
        if (item.subitems?.length) {
          result.push(...flatten(item.subitems, level + 1));
        }
      }
      return result;
    };
    return flatten(chapters);
  }, [chapters]);

  // Subscribe to controller events
  useEffect(() => {
    const handleStateChange = (e: Event) => {
      const newState = (e as CustomEvent<RsvpState>).detail;
      setState(newState);
    };

    const handleCountdownChange = (e: Event) => {
      setCountdown((e as CustomEvent<number | null>).detail);
    };

    const handleRequestNextPage = () => {
      onRequestNextPage();
    };

    controller.addEventListener('rsvp-state-change', handleStateChange);
    controller.addEventListener('rsvp-countdown-change', handleCountdownChange);
    controller.addEventListener('rsvp-request-next-page', handleRequestNextPage);

    return () => {
      controller.removeEventListener('rsvp-state-change', handleStateChange);
      controller.removeEventListener('rsvp-countdown-change', handleCountdownChange);
      controller.removeEventListener('rsvp-request-next-page', handleRequestNextPage);
    };
  }, [controller, onRequestNextPage]);

  // Keyboard shortcuts - use capture phase to intercept before native elements
  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (!state.active) return;
      // While the dictionary is open it owns the keyboard (e.g. Escape closes
      // the dictionary, not the whole RSVP session).
      if (dict) return;
      // Dictionary management (settings dialog) opens OVER RSVP; let it own the
      // keyboard so its inputs accept space and Escape closes it, not RSVP.
      if (isSettingsDialogOpen) return;
      // A focused text field (the WPM entry in the speed dropdown) owns its
      // keystrokes: arrows move the caret, Space/digits type, Escape discards
      // the draft. The reader's own shortcuts already ignore inputs.
      if (event.target instanceof HTMLInputElement && event.target.type === 'text') return;

      // The progress slider owns arrow keys while focused (#D1): the global
      // capture handler must not steal ArrowLeft/Right, or the slider (role=slider)
      // can never act on the arrows it declares. Its own onKeyDown seeks.
      const active = document.activeElement;
      if (
        active?.getAttribute('role') === 'slider' &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      ) {
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          event.stopPropagation();
          transportToggleRef.current();
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          // Close the topmost open layer first (#C8): a dropdown / rate picker /
          // pending lookup / the settings row. Only when nothing is layered on
          // top does Escape close the whole session.
          if (showChapterDropdown) setShowChapterDropdown(false);
          else if (showRateDropdown) setShowRateDropdown(false);
          else if (lookup) setLookup(null);
          else if (showSettings) setShowSettings(false);
          else onClose();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            controller.skipBackward(15);
          } else {
            controller.decreaseSpeed();
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            controller.skipForward(15);
          } else {
            controller.increaseSpeed();
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          event.stopPropagation();
          controller.increaseSpeed();
          break;
        case 'ArrowDown':
          event.preventDefault();
          event.stopPropagation();
          controller.decreaseSpeed();
          break;
        case '.':
          event.preventDefault();
          event.stopPropagation();
          controller.nextWord();
          break;
        case ',':
          event.preventDefault();
          event.stopPropagation();
          controller.prevWord();
          break;
      }
    };

    // Use capture phase to handle events before they reach dropdown/select elements
    document.addEventListener('keydown', handleKeyboard, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyboard, { capture: true });
  }, [
    state.active,
    controller,
    onClose,
    dict,
    isSettingsDialogOpen,
    showChapterDropdown,
    showRateDropdown,
    lookup,
    showSettings,
  ]);

  // Preload the RSVP high-legibility faces (#C13). The @font-face rules use
  // `font-display: swap`, so a cold start can flash the fallback then swap
  // mid-session — jarring for a single-word display. Warming the two weights of
  // both families (Atkinson Hyperlegible + Heebo; bold ORP needs 700) on mount
  // avoids that frame. Links are added once and cleaned up on unmount.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const hrefs = [
      '/fonts/AtkinsonHyperlegible-400.woff2',
      '/fonts/AtkinsonHyperlegible-700.woff2',
      '/fonts/Heebo-400.woff2',
      '/fonts/Heebo-700.woff2',
    ];
    const links = hrefs.map((href) => {
      const existing = document.head.querySelector<HTMLLinkElement>(
        `link[rel="preload"][href="${href}"]`,
      );
      if (existing) return null;
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'font';
      link.type = 'font/woff2';
      link.href = href;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
      return link;
    });
    return () => {
      for (const link of links) link?.remove();
    };
  }, []);

  // Dialog focus management (#D2): move focus into the overlay on mount, and
  // contain Tab within it. Runs once the surface is active; the dictionary /
  // settings dialog manage their own focus while open.
  useEffect(() => {
    if (!state.active) return;
    const root = overlayRootRef.current;
    if (!root) return;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [role="slider"], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    // Initial focus: the first control, else the root itself.
    (focusables()[0] ?? root).focus?.();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (dict || isSettingsDialogOpen) return;
      const els = focusables();
      if (els.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = els[0]!;
      const last = els[els.length - 1]!;
      const activeEl = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (activeEl === first || !root.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !root.contains(activeEl)) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [state.active, dict, isSettingsDialogOpen]);

  // Auto-pause when the tab/app loses focus, so the reader never plays on
  // unseen and you don't lose your place.
  useEffect(() => {
    const pauseIfPlaying = () => {
      if (controller.currentState.playing) controller.pause();
    };
    const onVisibility = () => {
      if (document.hidden) pauseIfPlaying();
    };
    window.addEventListener('blur-sm', pauseIfPlaying);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur-sm', pauseIfPlaying);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [controller]);

  // Comfort mode: a subtle fade-in on each new word/chunk to soften the hard
  // cut between flashes. Off by default; cheap and no-op where unsupported.
  useEffect(() => {
    if (!state.smoothFlashes) return;
    // Respect prefers-reduced-motion (#D5): skip the comfort fade for users who
    // opt out of animation.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    wordDisplayRef.current?.animate?.([{ opacity: 0.45 }, { opacity: 1 }], {
      duration: 45,
      easing: 'ease-out',
    });
  }, [state.currentIndex, state.smoothFlashes]);

  // Safety: release press-and-hold slow-mo if the overlay unmounts mid-hold —
  // the controller instance is reused across sessions, so a stuck flag would
  // leak into the next one.
  useEffect(() => {
    return () => {
      if (holdSlowTimer.current) clearTimeout(holdSlowTimer.current);
      if (holdSlowActive.current) controller.setHoldSlow(false);
    };
  }, [controller]);

  const effectiveChapterHref = currentChapterHref;

  // Word display helpers
  const wordBefore = currentWord ? currentWord.text.substring(0, currentWord.orpIndex) : '';
  const orpChar = currentWord ? currentWord.text.charAt(currentWord.orpIndex) : '';
  const wordAfter = currentWord ? currentWord.text.substring(currentWord.orpIndex + 1) : '';
  const isCJKWord = currentWord ? containsCJK(currentWord.text) : false;
  // RTL words (Arabic, Hebrew, …) must never be split into before/orp/after
  // spans: slicing by character index breaks letter shaping and reverses the
  // visual order. Render them whole instead, like CJK Highlight Word (#4630).
  const isRTLWord = currentWord ? isRTLText(currentWord.text) : false;
  // Overall reading direction of the book, driving RTL mirroring of the whole
  // overlay. Prefer the reader's authoritative `rtl` view setting; otherwise
  // trust an explicit RTL book language; otherwise sample across ALL words (not
  // the visible window, so it stays stable when the context scrolls past an
  // embedded English quote or a run of numbers).
  const isRTLDoc = useMemo(() => {
    if (rtl !== undefined) return rtl;
    if (lang && /^(he|iw|ar|fa|ur|yi|ps|sd|dv|ug|arc|syr|ckb)(-|_|$)/i.test(lang)) {
      return true;
    }
    const words = state.words;
    if (words.length === 0) return false;
    const step = Math.max(1, Math.floor(words.length / 300));
    let rtlCount = 0;
    let letters = 0;
    for (let i = 0; i < words.length; i += step) {
      const t = words[i]?.text;
      if (!t) continue;
      if (/\p{L}/u.test(t)) letters++;
      if (isRTLText(t)) rtlCount++;
    }
    return letters > 0 && rtlCount / letters > 0.5;
  }, [rtl, state.words, lang]);
  const currentFontSize =
    FONT_SIZE_OPTIONS[fontSizeIndex] ?? FONT_SIZE_OPTIONS[DEFAULT_FONT_SIZE_INDEX]!;
  // Gap between the ORP glyph and the side halves. Widened slightly (#C14) so a
  // wide ORP glyph (W/M-class, ~0.45em half-width) doesn't collide with the
  // before/after halves; CJK glyphs are full-width and need more.
  const wordSideOffset = isCJKWord ? '0.5em' : '0.4em';

  // Time remaining calculation
  const getTimeRemaining = useCallback((): string | null => {
    if (!state || state.words.length === 0) return null;
    const wordsLeft = state.words.length - state.currentIndex;
    const minutesLeft = wordsLeft / state.wpm;

    if (minutesLeft < 1) {
      const seconds = Math.ceil(minutesLeft * 60);
      return `${seconds}s`;
    } else if (minutesLeft < 60) {
      const mins = Math.floor(minutesLeft);
      const secs = Math.round((minutesLeft - mins) * 60);
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    } else {
      const hours = Math.floor(minutesLeft / 60);
      const mins = Math.round(minutesLeft % 60);
      return `${hours}h ${mins}m`;
    }
  }, [state]);

  // Auto-scroll: keep highlighted word in view. Suppressed while the user is
  // selecting text or has the dictionary open, so the panel does not yank the
  // selection out from under them (#4475).
  useEffect(() => {
    // The panel only renders while paused; re-run on the playing flip so the
    // reveal-on-pause lands scrolled to the current word.
    if (transportPlaying || contextCollapsed || lookup || dict) return;
    contextWordRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [state.currentIndex, transportPlaying, contextCollapsed, lookup, dict]);

  // Shrink-to-fit measurement (#C1). After each word/chunk/font change, compare
  // the focal content's natural extent to the available width and scale it down
  // to fit. We measure at the wrapper's centre and take the furthest child edge
  // on either side (×2) so the absolutely-positioned split halves are included;
  // `getBoundingClientRect` reads the POST-transform box, so we divide the
  // measured extent by the currently-applied `scale` to recover the intrinsic
  // width. That's why re-measuring converges (≤2 cycles) instead of looping —
  // do NOT remove the `/scale` compensation.
  useEffect(() => {
    const container = wordDisplayRef.current;
    const measure = wordMeasureRef.current;
    if (!container || !measure) return;
    const compute = () => {
      const style = window.getComputedStyle(container);
      const padX = parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
      const available = container.clientWidth - padX;
      if (available <= 0) return;
      // Natural (unscaled) horizontal extent, centred on the wrapper.
      const scale = wordScale > 0 ? wordScale : 1;
      const measureRect = measure.getBoundingClientRect();
      const center = measureRect.left + measureRect.width / 2;
      let maxHalf = 0;
      for (const child of Array.from(measure.querySelectorAll('*'))) {
        const r = (child as HTMLElement).getBoundingClientRect();
        if (r.width === 0) continue;
        maxHalf = Math.max(maxHalf, Math.abs(r.left - center), Math.abs(r.right - center));
      }
      // Undo the current scale to recover the intrinsic half-extent.
      const naturalWidth = (maxHalf * 2) / scale;
      if (naturalWidth <= 0) return;
      const next = naturalWidth > available ? Math.max(available / naturalWidth, 0.15) : 1;
      setWordScale((prev) => (Math.abs(prev - next) > 0.01 ? next : prev));
    };
    compute();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => compute()) : null;
    ro?.observe(container);
    return () => ro?.disconnect();
  }, [
    state.currentIndex,
    currentFontSize,
    isChunk,
    isRTLWord,
    isCJKWord,
    highlightWholeWord,
    wordScale,
  ]);

  useEffect(() => {
    if (!showChapterDropdown) return;
    const raf = requestAnimationFrame(() => {
      const container = chapterDropdownRef.current;
      if (!container) return;
      const activeItem = container.querySelector<HTMLElement>('[data-active="true"]');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'center' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [showChapterDropdown]);

  const toggleContext = useCallback(() => {
    setContextCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY_CONTEXT, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const updateFontSize = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(FONT_SIZE_OPTIONS.length - 1, idx));
    setFontSizeIndex(clamped);
    try {
      localStorage.setItem(STORAGE_KEY_FONT_SIZE, String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const updateOrpColor = useCallback((idx: number) => {
    setOrpColorIndex(idx);
    try {
      localStorage.setItem(STORAGE_KEY_ORP_COLOR, String(idx));
    } catch {
      /* ignore */
    }
  }, []);

  const updateHighlightWholeWord = useCallback((value: boolean) => {
    setHighlightWholeWord(value);
    try {
      localStorage.setItem(STORAGE_KEY_HIGHLIGHT_WORD, value ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  // Chapter helpers
  const getCurrentChapterLabel = useCallback((): string => {
    if (!effectiveChapterHref) return _('Select Chapter');
    const exactMatch = flatChapters.find((c) => c.href === effectiveChapterHref);
    if (exactMatch) return exactMatch.label;
    const normalizedCurrent = effectiveChapterHref.split('#')[0]?.replace(/^\//, '') || '';
    const chapter = flatChapters.find((c) => {
      const normalizedHref = c.href.split('#')[0]?.replace(/^\//, '') || '';
      return normalizedHref === normalizedCurrent;
    });
    return chapter?.label || _('Select Chapter');
  }, [_, effectiveChapterHref, flatChapters]);

  const isChapterActive = useCallback(
    (href: string): boolean => {
      if (!effectiveChapterHref) return false;
      if (href === effectiveChapterHref) return true;
      const normalizedCurrent = effectiveChapterHref.split('#')[0]?.replace(/^\//, '') || '';
      const normalizedHref = href.split('#')[0]?.replace(/^\//, '') || '';
      return normalizedHref === normalizedCurrent;
    },
    [effectiveChapterHref],
  );

  // Touch handlers
  const cancelHoldSlow = () => {
    if (holdSlowTimer.current) {
      clearTimeout(holdSlowTimer.current);
      holdSlowTimer.current = null;
    }
    if (holdSlowActive.current) {
      holdSlowActive.current = false;
      controller.setHoldSlow(false);
    }
  };

  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
    touchStartTime.current = Date.now();

    // Press-and-hold on the reading area engages slow-mo until release. The
    // 400ms delay keeps it clear of the tap window (taps are < 300ms), so a
    // slightly slow tap stays a no-op rather than a slow-mo blip. Skip the
    // header/footer controls, which own their own gestures.
    const target = event.target as HTMLElement;
    if (target.closest('.rsvp-controls') || target.closest('.rsvp-header')) return;
    holdSlowTimer.current = setTimeout(() => {
      holdSlowActive.current = true;
      controller.setHoldSlow(true);
    }, 400);
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!holdSlowTimer.current && !holdSlowActive.current) return;
    const touch = event.touches[0];
    if (!touch) return;
    // Movement means a swipe/scroll, not a hold — cancel slow-mo.
    if (
      Math.abs(touch.clientX - touchStartX.current) > TAP_THRESHOLD ||
      Math.abs(touch.clientY - touchStartY.current) > TAP_THRESHOLD
    ) {
      cancelHoldSlow();
    }
  };

  // Touch taps synthesize a trailing `click`; stamp every touch end so the
  // mouse click-to-pause handler below can tell real mouse clicks apart and
  // the dedicated tap zones (skip quarters / centre toggle) stay authoritative
  // on touch devices.
  const lastTouchEndAtRef = useRef(0);

  const handleTouchEnd = (event: React.TouchEvent) => {
    lastTouchEndAtRef.current = Date.now();
    // A completed press-and-hold releases slow-mo; it is not a tap or swipe.
    if (holdSlowActive.current) {
      cancelHoldSlow();
      return;
    }
    cancelHoldSlow();

    if (event.changedTouches.length !== 1) return;

    // Touches starting on the header or footer controls (progress bar, buttons,
    // dropdowns) own their own gestures — never let a horizontal drag here be
    // hijacked as a speed-change swipe, or a tap as a region tap.
    const target = event.target as HTMLElement;
    if (target.closest('.rsvp-controls') || target.closest('.rsvp-header')) {
      return;
    }

    const touch = event.changedTouches[0]!;
    const deltaX = touch.clientX - touchStartX.current;
    const deltaY = touch.clientY - touchStartY.current;
    const duration = Date.now() - touchStartTime.current;

    if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX > 0) {
        controller.decreaseSpeed();
      } else {
        controller.increaseSpeed();
      }
      return;
    }

    if (Math.abs(deltaX) < TAP_THRESHOLD && Math.abs(deltaY) < TAP_THRESHOLD && duration < 300) {
      const screenWidth = window.innerWidth;
      const tapX = touch.clientX;

      // Symmetric mirror gestures (#C6): the left and right quarters both skip
      // the same unit (15 words) in opposite directions, so users build one
      // mental model. (Paragraph-symmetry isn't possible — the controller has
      // rewindParagraph but no forward-paragraph equivalent.) In RTL, reading
      // flows right-to-left, so the far edges swap: tapping left goes forward.
      if (tapX < screenWidth * 0.25) {
        if (isRTLDoc) controller.skipForward(15);
        else controller.skipBackward(15);
      } else if (tapX > screenWidth * 0.75) {
        if (isRTLDoc) controller.skipBackward(15);
        else controller.skipForward(15);
      } else {
        transportToggleRef.current();
      }
    }
  };

  // Mouse/pen: a click anywhere on the overlay toggles play/pause — pause
  // while reading, resume while paused — except on elements that are meant to
  // do something else (header, controls, context panel, buttons, sliders,
  // dialogs; clicks on context words seek, not resume). Touch devices keep
  // their dedicated tap zones (skip quarters / centre toggle); their
  // synthesized clicks are filtered via lastTouchEndAtRef.
  const handleRootClick = (event: React.MouseEvent) => {
    if (Date.now() - lastTouchEndAtRef.current < 700) return;
    const target = event.target as HTMLElement;
    if (target.closest('.rsvp-controls, .rsvp-header, button, a, input, select, [role="slider"]')) {
      return;
    }
    // Inner dialogs (dictionary sheet, etc.) own their clicks — but the
    // overlay ROOT is itself role=dialog, so only bail for nested ones.
    const dialog = target.closest('[role="dialog"]');
    if (dialog && dialog !== event.currentTarget) return;
    // Don't pause away an active text selection (e.g. drag-select in the word
    // area on desktop).
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    transportToggleRef.current();
  };

  const handleWordClick = useCallback(
    (wordIndex: number) => {
      const wasPlaying = state.playing;
      if (wasPlaying) controller.pause();
      controller.seekToIndex(wordIndex);
      if (wasPlaying) setTimeout(() => controller.resume(), 50);
    },
    [state.playing, controller],
  );

  const handleContextClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // A drag that selects text also ends in a click; don't seek then, so the
      // user can select words for dictionary lookup (#4475).
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-rsvp-word-index]');
      if (!target) return;
      // Only non-current words are seek targets (#D3).
      if (!target.hasAttribute('data-rsvp-word-clickable')) return;
      const idx = parseInt(target.getAttribute('data-rsvp-word-index') || '', 10);
      if (Number.isNaN(idx)) return;
      handleWordClick(idx);
    },
    [handleWordClick],
  );

  // Detect a selection inside the context panel and surface a "Look up" pill.
  const handleContextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setLookup(null);
      return;
    }
    const text = selection.toString().trim();
    const anchor = selection.anchorNode;
    if (!text || !anchor || !contextPanelRef.current?.contains(anchor)) {
      setLookup(null);
      return;
    }
    // Clone the range so the placement survives the selection being collapsed
    // when the user taps the "Look up" pill.
    const range = selection.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 8, Math.max(8, rect.left + rect.width / 2));
    setLookup({ text, range, left, top: rect.top });
  }, []);

  const openLookup = useCallback(() => {
    if (!lookup) return;
    if (state.playing) controller.pause();

    // Anchor the popup to the selection: prefer below it, flip above when the
    // lower half of the screen is too short. The whole-window rect keeps the
    // popup clamped on-screen (the overlay root sits at the viewport origin).
    const rect = lookup.range.getBoundingClientRect();
    const windowRect = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    const popupWidth = Math.min(DICT_POPUP_MAX_WIDTH, window.innerWidth - 2 * DICT_POPUP_PADDING);
    const popupHeight = Math.min(
      DICT_POPUP_MAX_HEIGHT,
      window.innerHeight - 2 * DICT_POPUP_PADDING,
    );
    const dir: Position['dir'] =
      window.innerHeight - rect.bottom > popupHeight + DICT_POPUP_PADDING ? 'down' : 'up';
    const trianglePosition: Position = {
      point: { x: rect.left + rect.width / 2, y: dir === 'down' ? rect.bottom + 6 : rect.top - 12 },
      dir,
    };
    const position = getPopupPosition(
      trianglePosition,
      windowRect,
      popupWidth,
      popupHeight,
      DICT_POPUP_PADDING,
    );

    setDict({ word: lookup.text, position, trianglePosition });
    setLookup(null);
  }, [lookup, state.playing, controller]);

  const closeLookup = useCallback(() => {
    setDict(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
  }, []);

  const contextWindow = useMemo(() => {
    const len = state.words.length;
    if (len === 0) return { start: 0, end: 0 };
    const chunkStart = Math.floor(state.currentIndex / CONTEXT_CHUNK_SIZE) * CONTEXT_CHUNK_SIZE;
    const start = Math.max(0, chunkStart - CONTEXT_WINDOW_BEFORE);
    const end = Math.min(len, chunkStart + CONTEXT_CHUNK_SIZE + CONTEXT_WINDOW_AFTER);
    return { start, end };
  }, [state.currentIndex, state.words.length]);

  const hasMoreBefore = contextWindow.start > 0;
  const hasMoreAfter = contextWindow.end < state.words.length;

  const handleChapterSelect = (href: string) => {
    setShowChapterDropdown(false);
    controller.pause();
    onChapterSelect(href);
  };

  if (!state.active) return null;

  // Use theme colors directly from themeCode (bg, fg, primary are already resolved from palette)
  const bgColor = themeCode.bg;
  const fgColor = themeCode.fg;
  const accentColor = themeCode.primary;
  const effectiveOrpColor = ORP_COLOR_OPTIONS[orpColorIndex] || accentColor;
  // Named, translated labels for the ORP colour swatches (#D5) — index 0 is the
  // theme colour (labelled separately); the rest name the visible hue so a
  // screen reader announces "Red" rather than the meaningless "Color 2".
  const ORP_COLOR_LABELS = [
    _('Theme color'),
    _('Red'),
    _('Blue'),
    _('Green'),
    _('Orange'),
    _('Purple'),
  ];

  // The WPM timer doesn't drive pacing while RSVP follows TTS — the voice does.
  // Replace the WPM control with an "Audio pace" affordance that opens a TTS
  // rate picker instead (decision 6, #3235).
  // 'paused' keeps the WPM "Audio pace" lock too, so pausing doesn't shift layout.
  const ttsDriven =
    ttsSyncStatus === 'following' || ttsSyncStatus === 'syncing' || ttsSyncStatus === 'paused';

  return (
    <div
      ref={overlayRootRef}
      data-testid='rsvp-overlay'
      role='dialog'
      aria-modal='true'
      data-capture-blocking-overlay='true'
      aria-label={_('Speed Reading')}
      tabIndex={-1}
      // RTL books mirror the whole overlay. The layout is built on logical
      // properties (ms-/me-, ps-/pe-, start-/end-, text-start), so flipping
      // `dir` reflows the header, transport and dropdowns correctly.
      dir={isRTLDoc ? 'rtl' : 'ltr'}
      className='fixed inset-0 z-[100] flex select-none flex-col'
      style={{
        paddingTop: `${gridInsets.top}px`,
        paddingBottom: `${gridInsets.bottom * 0.33}px`,
        // Physical (not logical) padding: in landscape the notch and rounded
        // corners sit on a fixed side of the device, so these must not flip
        // with the book's reading direction.
        paddingLeft: `${gridInsets.left}px`,
        paddingRight: `${gridInsets.right}px`,
        backgroundColor: bgColor,
        color: fgColor,
        backdropFilter: 'none',
        // @ts-expect-error CSS custom properties
        '--rsvp-accent': accentColor,
        '--rsvp-fg': fgColor,
        '--rsvp-bg': bgColor,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={cancelHoldSlow}
      onClick={handleRootClick}
    >
      {/* ── Header ── */}
      <div className='rsvp-header flex shrink-0 items-center gap-2 px-3 py-2 md:gap-3 md:px-5 md:py-3'>
        <button
          aria-label={_('Close Speed Reading')}
          title={_('Close')}
          className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-gray-500/20'
          onClick={onClose}
        >
          <IoClose className='h-5 w-5' />
        </button>

        {/* Chapter selector */}
        <div className='relative min-w-0 flex-1'>
          <button
            className='relative flex w-full items-center gap-1.5 overflow-hidden rounded-full border border-gray-500/20 bg-gray-500/10 px-3 py-1.5 text-sm transition-colors hover:bg-gray-500/20'
            onClick={() => setShowChapterDropdown(!showChapterDropdown)}
          >
            {/* Reading progress doubles as the title bar's background: an
                accent-tinted fill growing from the inline-start edge (start-0
                flips for RTL). Replaces the old footer progress bar. */}
            <span
              aria-hidden
              data-testid='rsvp-title-progress-fill'
              className='absolute inset-y-0 start-0 transition-[width] duration-300'
              style={{
                width: `${state.progress}%`,
                backgroundColor: 'color-mix(in srgb, var(--rsvp-accent) 22%, transparent)',
              }}
            />
            <span className='relative min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start'>
              {getCurrentChapterLabel()}
            </span>
            {getTimeRemaining() && (
              <span className='relative shrink-0 whitespace-nowrap text-xs tabular-nums opacity-60'>
                {_('{{time}} left', { time: getTimeRemaining() })}
              </span>
            )}
            <svg
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              className='relative h-3.5 w-3.5 shrink-0 opacity-50'
            >
              <path d='M6 9l6 6 6-6' />
            </svg>
          </button>
          {showChapterDropdown && (
            <>
              <Overlay onDismiss={() => setShowChapterDropdown(false)} />
              <div
                ref={chapterDropdownRef}
                className='absolute left-0 right-0 top-full z-[100] mt-1.5 max-h-64 overflow-y-auto rounded-2xl border border-gray-500/20 px-2 shadow-2xl'
                style={{ backgroundColor: bgColor }}
              >
                {flatChapters.map((chapter, idx) => (
                  <button
                    key={`${chapter.href}-${idx}`}
                    data-active={isChapterActive(chapter.href) ? 'true' : undefined}
                    className={clsx(
                      'block w-full rounded-md border-none bg-transparent px-4 py-2.5 text-start text-sm transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-gray-500/15',
                      isChapterActive(chapter.href) &&
                        'bg-[color-mix(in_srgb,var(--rsvp-accent)_15%,transparent)] font-semibold',
                    )}
                    style={{ paddingLeft: `${1 + chapter.level * 0.875}rem` }}
                    onClick={() => handleChapterSelect(chapter.href)}
                  >
                    {chapter.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* WPM selector — while RSVP follows TTS the timer no longer paces, so it
            becomes an "Audio pace" affordance that opens a TTS rate picker
            instead (decision 6). It stays a real, enabled button (it opens the
            picker), so no aria-disabled; the lock glyph + border reads in e-ink
            without relying on opacity. */}
        <div className='relative shrink-0'>
          {ttsDriven ? (
            <button
              className='eink-bordered flex items-center gap-1.5 rounded-full border border-gray-500/20 bg-gray-500/10 px-3 py-1.5 text-sm transition-colors hover:bg-gray-500/20'
              onClick={() => setShowRateDropdown(!showRateDropdown)}
              aria-label={_('Audio pace')}
              title={_('Speed follows audio')}
            >
              <IoLockClosed className='h-3.5 w-3.5 shrink-0 opacity-70' aria-hidden='true' />
              <span className='font-medium'>{_('Audio pace')}</span>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                className='ms-0.5 h-3 w-3 shrink-0 opacity-50'
              >
                <path d='M6 9l6 6 6-6' />
              </svg>
            </button>
          ) : (
            // Speed control: an always-visible slider over the controller's WPM
            // range (the option list doubles as its bounds), live-applied on
            // drag — no popover to open first.
            <div
              className='flex items-center gap-2 rounded-full border border-gray-500/20 bg-gray-500/10 px-3 py-1.5'
              title={_('Reading speed')}
            >
              <span className='min-w-[2.2em] text-sm font-semibold tabular-nums'>{state.wpm}</span>
              <input
                type='range'
                data-testid='rsvp-wpm-slider'
                min={controller.getWpmOptions()[0]}
                max={controller.getWpmOptions().slice(-1)[0]}
                step={25}
                value={state.wpm}
                onChange={(e) => controller.setWpm(parseInt(e.target.value, 10))}
                className='w-24 cursor-pointer md:w-40'
                style={{ accentColor }}
                aria-label={_('Reading speed')}
              />
            </div>
          )}
          {showRateDropdown && ttsDriven && (
            <>
              <Overlay onDismiss={() => setShowRateDropdown(false)} />
              <div
                className='absolute end-0 top-full z-[100] mt-1.5 max-h-64 min-w-[7rem] overflow-y-auto rounded-2xl border border-gray-500/20 shadow-2xl'
                style={{ backgroundColor: bgColor }}
              >
                {TTS_RATE_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    className={clsx(
                      'flex w-full items-center justify-between gap-3 whitespace-nowrap rounded-md border-none bg-transparent px-4 py-1.5 text-sm tabular-nums transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-gray-500/15',
                      Math.abs(ttsRate - rate) < 0.001 &&
                        'bg-[color-mix(in_srgb,var(--rsvp-accent)_15%,transparent)] font-semibold',
                    )}
                    onClick={() => {
                      onSetTtsRate?.(rate);
                      setShowRateDropdown(false);
                    }}
                  >
                    <span>{rate.toFixed(2)}×</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* TTS "following audio" status row — slim, below the header and above the
          context panel (never inside the transport row). Uses the 'plain' variant
          to match the overlay's own theme-painted surface. idle/unsupported
          collapse to nothing. */}
      {(ttsSyncStatus === 'following' ||
        ttsSyncStatus === 'syncing' ||
        ttsSyncStatus === 'decoupled' ||
        ttsSyncStatus === 'paused') && (
        <div className='flex shrink-0 justify-center px-3 pb-1 md:px-4'>
          <TTSFollowIndicator
            status={ttsSyncStatus}
            estimated={estimated}
            onResume={onResumeTtsFollow}
            variant='plain'
          />
        </div>
      )}

      {/* Main content area */}
      <div className='flex flex-1 flex-col items-center justify-center p-4 md:p-6'>
        <div className='flex h-full w-full flex-col items-center justify-center'>
          <div className='flex h-full w-full flex-col items-center'>
            {/* Top guide line */}
            <div className='w-px flex-1 bg-current opacity-30' />

            {/* Word section */}
            <div className='relative flex w-full flex-col items-center justify-center'>
              {/* Countdown — rendered as an absolute overlay above the focal word
                  so it never pushes the word down/up on start/resume (#C5). The
                  pulse animation is suppressed under prefers-reduced-motion (#D5). */}
              {countdown !== null && (
                <div className='pointer-events-none absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center justify-center'>
                  <span
                    className='text-5xl font-bold motion-safe:animate-pulse sm:text-6xl md:text-7xl'
                    style={{ color: accentColor }}
                  >
                    {countdown}
                  </span>
                </div>
              )}

              {/* Word display */}
              <div
                ref={wordDisplayRef}
                className={clsx(
                  'rsvp-word relative flex min-h-16 w-full items-center justify-center whitespace-nowrap px-2 py-2 font-medium leading-none sm:min-h-20 sm:px-4 sm:py-4',
                  // Fall back to a fixed-width font only when the reader has no
                  // configured font face/family to apply.
                  !fontFamily && 'font-mono',
                )}
                style={{
                  fontSize: `${currentFontSize}rem`,
                  fontFamily,
                }}
              >
                {/* Inner scaling wrapper (#C1): the positioning context for the
                    split before/orp/after halves, and the element we shrink to
                    fit long words. Scaling around the centre keeps the ORP
                    anchored. */}
                <div
                  ref={wordMeasureRef}
                  className='relative flex items-center justify-center'
                  style={{ transform: wordScale < 1 ? `scale(${wordScale})` : undefined }}
                >
                  {isChunk ? (
                    // Direction is applied PER WORD below (#C7) — a Latin-dominant
                    // chunk with one Hebrew word must not flip its whole order.
                    <div className='flex items-baseline justify-center gap-[0.4em]'>
                      {currentChunk.map((w, i) => {
                        const wordIndex = state.currentIndex + i;
                        const cjk = containsCJK(w.text);
                        const rtl = isRTLText(w.text);
                        if (rtl || (cjk && highlightWholeWord)) {
                          // RTL words have no ORP, so render in the default colour
                          // (#A8); only the opt-in CJK Highlight Word mode colours the
                          // whole word.
                          return (
                            <span
                              key={wordIndex}
                              className='font-bold'
                              style={rtl ? undefined : { color: effectiveOrpColor }}
                              dir={rtl ? 'rtl' : undefined}
                            >
                              {w.text}
                            </span>
                          );
                        }
                        const before = w.text.substring(0, w.orpIndex);
                        const orp = w.text.charAt(w.orpIndex);
                        const after = w.text.substring(w.orpIndex + 1);
                        return (
                          // No opacity on the word span: dimming here also dims
                          // the nested ORP (CSS group-opacity — a child can't be
                          // more opaque than its parent), so the highlight never
                          // popped in chunk mode. Non-focus letters render at full
                          // colour; the ORP stands out via colour + weight.
                          <span key={wordIndex} dir={rtl ? 'rtl' : undefined}>
                            {before}
                            <span
                              className='relative font-bold'
                              style={{ color: effectiveOrpColor }}
                            >
                              {i === longestChunkIdx && orpTicks}
                              {orp}
                            </span>
                            {after}
                          </span>
                        );
                      })}
                    </div>
                  ) : currentWord ? (
                    isRTLWord || (isCJKWord && highlightWholeWord) ? (
                      // Whole-word mode: center the full word instead of anchoring a
                      // single focus character. Used for CJK Highlight Word and always
                      // for RTL words, whose shaping/order would break if sliced into
                      // before/orp/after spans (#4630). dir=rtl restores correct letter
                      // order and connection for RTL. RTL words have no ORP, so they
                      // render in the default text colour (#A8); only the opt-in CJK
                      // Highlight Word mode colours the whole word.
                      <span
                        className='rsvp-word-whole relative z-10 whitespace-nowrap font-bold'
                        style={isRTLWord ? undefined : { color: effectiveOrpColor }}
                        dir={isRTLWord ? 'rtl' : undefined}
                      >
                        {currentWord.text}
                      </span>
                    ) : (
                      <>
                        <span
                          className='rsvp-word-before absolute whitespace-nowrap text-right'
                          style={{ right: `calc(50% + ${wordSideOffset})` }}
                        >
                          {wordBefore}
                        </span>
                        <span
                          className='rsvp-word-orp relative z-10 font-bold'
                          style={{ color: effectiveOrpColor }}
                        >
                          {orpTicks}
                          {orpChar}
                        </span>
                        <span
                          className='rsvp-word-after absolute whitespace-nowrap text-left'
                          style={{ left: `calc(50% + ${wordSideOffset})` }}
                        >
                          {wordAfter}
                        </span>
                      </>
                    )
                  ) : (
                    <span className='italic opacity-30'>{_('Ready')}</span>
                  )}
                </div>
              </div>

              {/* Context panel — an ABSOLUTE overlay directly beneath the focal
                  word (out of flow, like the countdown above it, #C5), so its
                  reveal on pause never shifts the word. Shown only while
                  PAUSED: during playback it's motion in the periphery that
                  competes with the focal word; on pause it's the
                  re-orientation aid. The positioning wrapper is
                  pointer-events-none so clicks in its gutters fall through to
                  the overlay root; the panel itself is `rsvp-controls`, so its
                  own gestures (collapse header tap, word taps, text selection)
                  are never hijacked by the tap-zone / slow-mo hold /
                  click-to-pause handlers (#C2). */}
              {!transportPlaying && (
                <div className='pointer-events-none absolute left-0 right-0 top-full z-20 mt-3 flex justify-center px-3 md:mt-5'>
                  <div
                    className='rsvp-controls pointer-events-auto w-full overflow-hidden rounded-lg border border-gray-500/20 md:max-w-2xl md:rounded-xl'
                    style={{
                      backgroundColor: `color-mix(in srgb, ${bgColor} 92%, var(--rsvp-fg))`,
                    }}
                  >
                    <button
                      className='flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide opacity-60 transition-opacity hover:opacity-80 md:px-4 md:py-3'
                      onClick={toggleContext}
                      aria-expanded={!contextCollapsed}
                      aria-label={contextCollapsed ? _('Show context') : _('Hide context')}
                    >
                      <svg
                        width='14'
                        height='14'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        className='md:h-4 md:w-4'
                      >
                        <path d='M4 6h16M4 12h16M4 18h10' />
                      </svg>
                      <span className='flex-1 text-start'>{_('Context')}</span>
                      <IoChevronDown
                        className={clsx(
                          'h-3.5 w-3.5 transition-transform duration-200',
                          !contextCollapsed && 'rotate-180',
                        )}
                      />
                    </button>
                    {!contextCollapsed && (
                      <div
                        className='px-3 pb-3 md:px-4 md:pb-4'
                        onTouchStart={(e) => e.stopPropagation()}
                        onTouchEnd={(e) => e.stopPropagation()}
                      >
                        <div
                          ref={contextPanelRef}
                          data-testid='rsvp-context-panel'
                          dir={isRTLDoc ? 'rtl' : 'ltr'}
                          className={clsx(
                            // 4lh = exactly four lines of THIS element's computed
                            // line-height, robust across breakpoints (md:text-lg
                            // swaps both font-size and line-height).
                            'max-h-[4lh] select-text overflow-y-auto text-base leading-loose md:text-lg',
                            isRTLDoc ? 'text-right' : 'text-left',
                          )}
                          style={{ fontFamily }}
                          onClick={handleContextClick}
                          onMouseUp={handleContextSelection}
                          onTouchEnd={handleContextSelection}
                        >
                          {hasMoreBefore && <span className='opacity-30'>… </span>}
                          {state.words.slice(contextWindow.start, contextWindow.end).map((w, i) => {
                            const wordIndex = contextWindow.start + i;
                            const isCurrent = wordIndex === state.currentIndex;
                            return (
                              <ContextWord
                                key={wordIndex}
                                text={w.text}
                                wordIndex={wordIndex}
                                isCurrent={isCurrent}
                                currentRef={isCurrent ? contextWordRef : undefined}
                                orpColor={isCurrent ? effectiveOrpColor : undefined}
                              />
                            );
                          })}
                          {hasMoreAfter && <span className='opacity-30'>…</span>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom guide line */}
            <div className='w-px flex-1 bg-current opacity-30' />
          </div>
        </div>
      </div>

      {/* Footer — transport only; chapter progress lives in the header title
          bar (fill + ETA), and the old drag-to-seek bar is gone. Seeking:
          tap zones / Shift+arrows / context-word clicks / chapter picker. */}
      <div className='rsvp-controls shrink-0 px-3 pb-6 pt-3 md:px-4 md:pb-8 md:pt-4'>
        {/* Playback controls. The audio/settings cluster is `absolute end-0`;
            reserve symmetric horizontal room (#C10) so the centered transport
            (esp. the `+` button) can't slip under the cluster on narrow phones
            (≲340px). The reserve is dropped at `sm` where width is ample. */}
        <div className='relative flex items-center justify-center gap-1 px-[5.5rem] sm:px-0 md:gap-2'>
          <button
            aria-label={_('Rewind to paragraph')}
            className='flex cursor-pointer items-center gap-0.5 rounded-full border-none bg-transparent px-2 py-1.5 transition-colors hover:bg-gray-500/20 active:scale-95'
            onClick={() => controller.rewindParagraph()}
            title={_('Rewind to paragraph start, then previous paragraph')}
          >
            <span className='text-xs font-semibold opacity-80'>¶</span>
            <IoPlaySkipBack className='h-5 w-5 md:h-6 md:w-6' />
          </button>

          <button
            aria-label={_('Decrease speed')}
            className='flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-colors hover:bg-gray-500/20 active:scale-95'
            onClick={() => controller.decreaseSpeed()}
            title={_('Slower (Left/Down)')}
          >
            <IoRemove className='h-4 w-4 md:h-5 md:w-5' />
          </button>

          <button
            aria-label={transportPlaying ? _('Pause') : _('Play')}
            className={clsx(
              'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-none bg-gray-500/15 transition-colors hover:bg-gray-500/25 active:scale-95 md:h-16 md:w-16',
              transportPlaying ? '' : 'ps-1',
            )}
            onClick={() => transportToggleRef.current()}
            title={transportPlaying ? _('Pause (Space)') : _('Play (Space)')}
          >
            {transportPlaying ? (
              <IoPause className='h-7 w-7 md:h-8 md:w-8' />
            ) : (
              <IoPlay className='h-7 w-7 md:h-8 md:w-8' />
            )}
          </button>

          <button
            aria-label={_('Increase speed')}
            className='flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-colors hover:bg-gray-500/20 active:scale-95'
            onClick={() => controller.increaseSpeed()}
            title={_('Faster (Right/Up)')}
          >
            <IoAdd className='h-4 w-4 md:h-5 md:w-5' />
          </button>

          {/* Trailing cluster: audio (TTS) toggle + divider + settings gear.
              The audio toggle starts TTS from the displayed word (or stops it
              when engaged) — never a second play triangle (decision 5). Active
              state uses a filled glyph + eink-bordered surface so it reads in
              e-ink without relying on color. */}
          <div className='absolute end-0 flex items-center gap-1'>
            <button
              aria-label={ttsActive ? _('Stop audio') : _('Play audio')}
              className={clsx(
                'touch-target flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-none transition-colors active:scale-95',
                ttsActive
                  ? 'eink-bordered bg-[color-mix(in_srgb,var(--rsvp-accent)_18%,transparent)]'
                  : 'bg-transparent hover:bg-gray-500/20',
              )}
              onClick={() => onToggleTtsAudio?.()}
              title={ttsActive ? _('Stop audio') : _('Play audio')}
            >
              {ttsActive ? (
                <IoVolumeHigh
                  className='h-4 w-4 md:h-5 md:w-5'
                  style={{ color: accentColor }}
                  aria-hidden='true'
                />
              ) : (
                <IoVolumeMediumOutline className='h-4 w-4 md:h-5 md:w-5' aria-hidden='true' />
              )}
            </button>

            <span className='h-5 w-px bg-gray-500/30' aria-hidden='true' />

            <button
              aria-label={_('Settings')}
              className={clsx(
                'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-colors hover:bg-gray-500/20 active:scale-95',
                showSettings && 'bg-gray-500/15',
              )}
              onClick={() => setShowSettings((prev) => !prev)}
              title={_('Settings')}
            >
              <IoSettingsSharp className='h-4 w-4 md:h-5 md:w-5' />
            </button>
          </div>
        </div>

        {/* Settings row (collapsible) */}
        {showSettings && (
          <div className='mt-3 flex flex-wrap items-center justify-evenly gap-x-8 gap-y-4 text-xs md:justify-center'>
            {/* Punctuation pause */}
            <label className='flex cursor-pointer items-center gap-1.5 font-medium opacity-80'>
              <span className='me-0.5 font-medium opacity-50'>{_('Punctuation Delay')}</span>
              <select
                className='cursor-pointer rounded-sm border border-gray-500/30 bg-gray-500/20 px-1.5 py-1 text-xs font-medium transition-colors hover:border-gray-500/40 hover:bg-gray-500/30'
                style={{ color: 'inherit' }}
                value={state.punctuationPauseMs}
                onChange={(e) => controller.setPunctuationPause(parseInt(e.target.value, 10))}
              >
                {controller.getPunctuationPauseOptions().map((option) => (
                  <option key={option} value={option}>
                    {option}ms
                  </option>
                ))}
              </select>
            </label>

            {/* Pre-start countdown delay */}
            <label className='flex cursor-pointer items-center gap-1.5 font-medium opacity-80'>
              <span className='me-0.5 font-medium opacity-50'>{_('Start Delay')}</span>
              <select
                data-testid='rsvp-start-delay-select'
                className='cursor-pointer rounded-sm border border-gray-500/30 bg-gray-500/20 px-1.5 py-1 text-xs font-medium transition-colors hover:border-gray-500/40 hover:bg-gray-500/30'
                style={{ color: 'inherit' }}
                value={state.startDelaySeconds}
                onChange={(e) => controller.setStartDelay(parseInt(e.target.value, 10))}
              >
                {controller.getStartDelayOptions().map((option) => (
                  <option key={option} value={option}>
                    {option === 0 ? _('Off') : `${option}s`}
                  </option>
                ))}
              </select>
            </label>

            {/* Font size */}
            <div className='flex items-center gap-0.5'>
              <span className='mr-0.5 font-medium opacity-50'>{_('Font')}</span>
              <button
                aria-label={_('Decrease font size')}
                className='flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-colors hover:bg-gray-500/20 active:scale-95'
                onClick={() => updateFontSize(fontSizeIndex - 1)}
                disabled={fontSizeIndex <= 0}
              >
                <IoRemove className='h-3 w-3' />
              </button>
              <span className='min-w-4 text-center font-medium tabular-nums'>
                {fontSizeIndex + 1}
              </span>
              <button
                aria-label={_('Increase font size')}
                className='flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-colors hover:bg-gray-500/20 active:scale-95'
                onClick={() => updateFontSize(fontSizeIndex + 1)}
                disabled={fontSizeIndex >= FONT_SIZE_OPTIONS.length - 1}
              >
                <IoAdd className='h-3 w-3' />
              </button>
            </div>

            {/* Split hyphenated words */}
            <div className='config-item gap-2'>
              <span className='opacity-50'>{_('Split Hyphens')}</span>
              <Toggle
                checked={state.splitHyphens}
                onChange={(e) => controller.setSplitHyphens(e.target.checked)}
              />
            </div>

            {/* Phrase chunking — flash intelligent multi-word phrases */}
            <div className='config-item gap-2'>
              <span className='opacity-50'>{_('Chunking')}</span>
              <input
                type='checkbox'
                data-testid='rsvp-chunking-toggle'
                className='toggle'
                checked={state.chunking}
                onChange={(e) => controller.setChunking(e.target.checked)}
              />
            </div>

            {/* Warm-up ramp — ease speed up over the first words after start */}
            <div className='config-item gap-2'>
              <span className='opacity-50'>{_('Warm-up')}</span>
              <input
                type='checkbox'
                data-testid='rsvp-warmup-toggle'
                className='toggle'
                checked={state.warmupRamp}
                onChange={(e) => controller.setWarmupRamp(e.target.checked)}
              />
            </div>

            {/* Smooth — comfort fade + small inter-chunk beat */}
            <div className='config-item gap-2'>
              <span className='opacity-50'>{_('Smooth')}</span>
              <input
                type='checkbox'
                data-testid='rsvp-smooth-toggle'
                className='toggle'
                checked={state.smoothFlashes}
                onChange={(e) => controller.setSmoothFlashes(e.target.checked)}
              />
            </div>

            {/* CJK character mode — split CJK text per-character */}
            {state.hasCJK && (
              <div className='config-item gap-2'>
                <span className='opacity-50'>{_('Character Mode')}</span>
                <Toggle
                  data-testid='rsvp-char-mode-toggle'
                  checked={state.cjkCharMode}
                  onChange={(e) => controller.setCjkCharMode(e.target.checked)}
                />
              </div>
            )}

            {/* CJK whole-word highlight — color and center the full word */}
            {state.hasCJK && (
              <div className='config-item gap-2'>
                <span className='opacity-50'>{_('Highlight Word')}</span>
                <Toggle
                  data-testid='rsvp-highlight-word-toggle'
                  checked={highlightWholeWord}
                  onChange={(e) => updateHighlightWholeWord(e.target.checked)}
                />
              </div>
            )}

            {/* ORP color */}
            <div className='flex items-center gap-1.5'>
              <span className='mr-0.5 font-medium opacity-50'>{_('Focus')}</span>
              {ORP_COLOR_OPTIONS.map((color, idx) => (
                <button
                  key={idx}
                  onClick={() => updateOrpColor(idx)}
                  className={clsx(
                    'h-6 min-h-6 w-6 min-w-6 rounded-full border-2 transition-transform',
                    orpColorIndex === idx
                      ? 'scale-110 border-current'
                      : 'border-transparent hover:scale-105',
                  )}
                  style={{ backgroundColor: color || accentColor }}
                  aria-label={idx === 0 ? _('Theme color') : ORP_COLOR_LABELS[idx]}
                  aria-pressed={orpColorIndex === idx}
                  title={idx === 0 ? _('Theme color') : ORP_COLOR_LABELS[idx]}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Dictionary lookup from a context selection (#4475) */}
      {lookup && (
        <button
          aria-label={_('Look up')}
          className='eink-bordered fixed z-[101] flex -translate-x-1/2 -translate-y-full items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold shadow-lg'
          style={{
            left: `${lookup.left}px`,
            top: `${lookup.top}px`,
            backgroundColor: accentColor,
            color: bgColor,
          }}
          onClick={openLookup}
        >
          <IoSearch className='h-4 w-4' />
          {_('Look up')}
        </button>
      )}
      {dict &&
        // Below `sm` (or short landscape) present a bottom sheet; otherwise an
        // anchored popup — mirroring the reader's selection dictionary.
        (window.innerWidth < 640 || window.innerHeight < 640 ? (
          <DictionarySheet
            word={dict.word}
            lang={lang}
            onDismiss={closeLookup}
            onManage={onManageDictionary}
          />
        ) : (
          // Transparent full-screen catcher so a click outside the popup
          // dismisses it (the popup container sits above it at z-50).
          <>
            <Overlay onDismiss={closeLookup} />
            <DictionaryPopup
              word={dict.word}
              lang={lang}
              position={dict.position}
              trianglePosition={dict.trianglePosition}
              popupWidth={Math.min(
                DICT_POPUP_MAX_WIDTH,
                window.innerWidth - 2 * DICT_POPUP_PADDING,
              )}
              popupHeight={Math.min(
                DICT_POPUP_MAX_HEIGHT,
                window.innerHeight - 2 * DICT_POPUP_PADDING,
              )}
              onDismiss={closeLookup}
              onManage={onManageDictionary}
            />
          </>
        ))}
    </div>
  );
};

export default RSVPOverlay;
