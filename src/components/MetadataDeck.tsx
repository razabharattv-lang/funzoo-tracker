import { useEffect, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  FileText,
  Hash,
  MessageSquareText,
  Tag,
  Type,
} from 'lucide-react';
import type { RenderedClipItem, RenderResultManifest } from '../types/studio';

interface MetadataDeckProps {
  result: RenderResultManifest | null;
  activeClip: RenderedClipItem | null;
  totalClips: number;
}

interface MetadataFieldSpec {
  key: 'title' | 'description' | 'tags' | 'hashtags' | 'posting_time';
  label: string;
  emptyHint: string;
  accentBorder: string;
  headerTint: string;
  iconBg: string;
  iconText: string;
  icon: typeof Type;
}

const METADATA_FIELDS: MetadataFieldSpec[] = [
  {
    key: 'title',
    label: 'Title',
    emptyHint: 'Grounded in live YouTube Data API v3 high-view Shorts titles',
    accentBorder: 'border-[#FF1744]',
    headerTint: 'bg-[#FFF1F3]',
    iconBg: 'bg-[#FF1744]',
    iconText: 'text-white',
    icon: Type,
  },
  {
    key: 'description',
    label: 'Description',
    emptyHint: 'SEO description tailored to fetched US trend keywords',
    accentBorder: 'border-[#3D5AFE]',
    headerTint: 'bg-[#EEF2FF]',
    iconBg: 'bg-[#3D5AFE]',
    iconText: 'text-white',
    icon: FileText,
  },
  {
    key: 'tags',
    label: 'Tags',
    emptyHint: '15 comma-separated tags grounded in live YouTube API tags',
    accentBorder: 'border-[#00BFA5]',
    headerTint: 'bg-[#E6FAF7]',
    iconBg: 'bg-[#00BFA5]',
    iconText: 'text-white',
    icon: Tag,
  },
  {
    key: 'hashtags',
    label: 'Hashtags',
    emptyHint: '7 targeted hashtags generated from live trend research',
    accentBorder: 'border-[#D98E00]',
    headerTint: 'bg-[#FFF8E1]',
    iconBg: 'bg-[#FFAB00]',
    iconText: 'text-[#0F172A]',
    icon: Hash,
  },
  {
    key: 'posting_time',
    label: 'Best Upload Time (USA EST + India IST)',
    emptyHint: 'Peak upload window calculated from top-performing Shorts timestamps',
    accentBorder: 'border-[#00C853]',
    headerTint: 'bg-[#E8F8EE]',
    iconBg: 'bg-[#00C853]',
    iconText: 'text-white',
    icon: Clock,
  },
];

export function MetadataDeck({
  result,
  activeClip,
  totalClips,
}: MetadataDeckProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const source = activeClip ?? result;

  useEffect(() => {
    setCopiedKey(null);
  }, [activeClip?.clip_index, result?.run_tag]);

  const handleCopy = async (key: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement('textarea');
      el.value = value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1800);
  };

  const handleCopyAll = () => {
    if (!source) return;
    const bundle = [
      `TITLE:\n${source.title}`,
      `DESCRIPTION:\n${source.description}`,
      `TAGS:\n${source.tags}`,
      `HASHTAGS:\n${source.hashtags}`,
      `BEST UPLOAD TIME (USA EST + INDIA IST):\n${source.posting_time}`,
    ].join('\n\n');
    void handleCopy('all', bundle);
  };

  return (
    <section aria-label="One-Click Copy Output Deck" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-[#0F172A] truncate">
            {totalClips > 1 && activeClip
              ? `Clip ${activeClip.clip_index} Copy Deck`
              : 'One-Click Copy Output Deck'}
          </h2>
          <p className="text-xs font-medium text-[#64748B]">
            Grounded in live YouTube Data API v3 trend data — zero dummy fields
          </p>
        </div>

        {source && (
          <button
            type="button"
            onClick={handleCopyAll}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              copiedKey === 'all'
                ? 'bg-[#00C853] border-[#00A344] text-white'
                : 'bg-white border-[#E2E8F0] text-[#0F172A] hover:border-[#00C853] hover:bg-[#E8F8EE] hover:text-[#065F46]'
            }`}
          >
            {copiedKey === 'all' ? (
              <>
                <Check className="w-3.5 h-3.5" strokeWidth={3} />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" strokeWidth={2.25} />
                <span>Copy All</span>
              </>
            )}
          </button>
        )}
      </div>

      <div className="space-y-2.5">
        {METADATA_FIELDS.map((field) => {
          const Icon = field.icon;
          const value = source?.[field.key] ?? '';
          const isCopied = copiedKey === field.key;

          return (
            <div
              key={field.key}
              className={`rounded-xl border-2 bg-white overflow-hidden transition-colors ${
                value ? field.accentBorder : 'border-[#E2E8F0]'
              }`}
            >
              <div
                className={`px-3.5 py-2 flex items-center justify-between gap-2 border-b-2 ${
                  value
                    ? `${field.headerTint} ${field.accentBorder}`
                    : 'bg-[#F4F6F9] border-[#E2E8F0]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${field.iconBg} ${field.iconText}`}
                  >
                    <Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
                  </span>
                  <span className="text-xs font-extrabold text-[#0F172A] truncate">
                    {field.label}
                  </span>
                </div>

                <button
                  type="button"
                  disabled={!value}
                  onClick={() => void handleCopy(field.key, value)}
                  className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    isCopied
                      ? 'bg-[#00C853] border-[#00A344] text-white'
                      : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:border-[#00C853] hover:bg-[#00C853] hover:text-white'
                  }`}
                >
                  {isCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5" strokeWidth={3} />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" strokeWidth={2.25} />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>

              <div className="px-3.5 py-2.5">
                {value ? (
                  <p className="text-sm font-semibold text-[#0F172A] leading-relaxed break-words whitespace-pre-line">
                    {value}
                  </p>
                ) : (
                  <p className="text-xs font-medium text-[#94A3B8]">
                    {field.emptyHint}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {source?.voiceover && (
          <div className="rounded-xl border-2 border-[#E2E8F0] bg-white overflow-hidden">
            <div className="px-3.5 py-2 bg-[#F4F6F9] border-b-2 border-[#E2E8F0] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded-md bg-[#0F172A] text-white flex items-center justify-center shrink-0">
                  <MessageSquareText className="w-3.5 h-3.5" strokeWidth={2.25} />
                </span>
                <span className="text-xs font-extrabold text-[#0F172A] truncate">
                  Suspense Loop Script ({source.voice_engine || result?.voice_gender})
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleCopy('voiceover', source.voiceover)}
                className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  copiedKey === 'voiceover'
                    ? 'bg-[#00C853] border-[#00A344] text-white'
                    : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:border-[#00C853] hover:bg-[#00C853] hover:text-white'
                }`}
              >
                {copiedKey === 'voiceover' ? (
                  <>
                    <Check className="w-3.5 h-3.5" strokeWidth={3} />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" strokeWidth={2.25} />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            <div className="px-3.5 py-2.5">
              <p className="text-xs font-semibold text-[#334155] leading-relaxed">
                {source.voiceover}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
