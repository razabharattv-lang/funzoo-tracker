import { useRef, useState } from 'react';
import {
  Check,
  ImagePlus,
  Loader2,
  Shirt,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { SavedCharacterAsset } from '../types/studio';

interface CharacterCardProps {
  enabled: boolean;
  savedCharacters: SavedCharacterAsset[];
  selectedCharacterId: string | null;
  outfitPrompt: string;
  disabled: boolean;
  isUploadingPortrait: boolean;
  uploadError: string | null;
  onToggleEnabled: (enabled: boolean) => void;
  onSelectCharacter: (id: string) => void;
  onUploadPortrait: (file: File) => void;
  onDeleteCharacter: (id: string) => void;
  onOutfitPromptChange: (value: string) => void;
}

export function CharacterCard({
  enabled,
  savedCharacters,
  selectedCharacterId,
  outfitPrompt,
  disabled,
  isUploadingPortrait,
  uploadError,
  onToggleEnabled,
  onSelectCharacter,
  onUploadPortrait,
  onDeleteCharacter,
  onOutfitPromptChange,
}: CharacterCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imgErrorIds, setImgErrorIds] = useState<Record<string, boolean>>({});

  const activeCharacter =
    savedCharacters.find((c) => c.id === selectedCharacterId) ??
    savedCharacters[0] ??
    null;

  return (
    <section
      aria-label="My Talking Character"
      className={`rounded-2xl border-2 p-5 transition-colors ${
        enabled ? 'border-[#FFAB00] bg-white' : 'border-[#E2E8F0] bg-white'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-[#FFAB00] text-[#0F172A] flex items-center justify-center shrink-0">
            <UserRound className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-[#0F172A] truncate">
              2. My Talking Character (Face-Lock &amp; Outfit)
            </h2>
            <p className="text-xs font-medium text-[#64748B]">
              Pattern-interrupt pop-ins at Opening Hook, Mid Climax &amp; Loop Outro
            </p>
          </div>
        </div>

        {/* Clean ON / OFF Toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={disabled}
          onClick={() => onToggleEnabled(!enabled)}
          className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border-2 text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-55 ${
            enabled
              ? 'bg-[#FFAB00] border-[#D98E00] text-[#0F172A]'
              : 'bg-[#F4F6F9] border-[#CBD5E1] text-[#475569] hover:border-[#FFAB00]'
          }`}
        >
          <span>{enabled ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        disabled={disabled || isUploadingPortrait}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUploadPortrait(file);
          e.target.value = '';
        }}
      />

      {enabled && (
        <div className="mt-4 pt-4 border-t-2 border-[#F1F5F9] space-y-4">
          {/* Active Portrait Preview + Upload Button */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border-2 border-[#FFAB00] bg-[#FFF8E1] p-3.5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-14 h-14 rounded-xl border-2 border-[#D98E00] bg-white overflow-hidden flex items-center justify-center shrink-0">
                {activeCharacter && !imgErrorIds[activeCharacter.id] ? (
                  <img
                    src={activeCharacter.url}
                    alt={activeCharacter.name}
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setImgErrorIds((prev) => ({
                        ...prev,
                        [activeCharacter.id]: true,
                      }))
                    }
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <UserRound className="w-6 h-6 text-[#B45309]" strokeWidth={2.25} />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-extrabold text-[#0F172A] truncate">
                  {activeCharacter ? activeCharacter.name : 'No portrait saved yet'}
                </p>
                <p className="text-xs font-semibold text-[#78350F] mt-0.5">
                  {activeCharacter
                    ? 'Face locked · Pops in at 0–2.5s hook, mid-twist & loop outro'
                    : 'Upload a clear front-facing photo (saved to Cloudinary + browser)'}
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={disabled || isUploadingPortrait}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl border-2 border-[#D98E00] bg-white text-[#0F172A] hover:bg-[#FFAB00] text-xs font-extrabold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-55"
            >
              {isUploadingPortrait ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.5} />
                  <span>Uploading...</span>
                </>
              ) : (
                <>
                  <ImagePlus className="w-3.5 h-3.5" strokeWidth={2.5} />
                  <span>{activeCharacter ? 'Add Portrait' : 'Upload Portrait'}</span>
                </>
              )}
            </button>
          </div>

          {/* Saved Portraits Strip (if user saved 1 or more portraits) */}
          {savedCharacters.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {savedCharacters.map((char) => {
                const isSelected = activeCharacter?.id === char.id;
                return (
                  <div
                    key={char.id}
                    className={`inline-flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-xl border-2 transition-colors ${
                      isSelected
                        ? 'border-[#FFAB00] bg-[#FFF8E1]'
                        : 'border-[#E2E8F0] bg-[#F4F6F9]'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onSelectCharacter(char.id)}
                      className="inline-flex items-center gap-2 text-left cursor-pointer"
                    >
                      <span className="w-7 h-7 rounded-lg overflow-hidden bg-white border border-[#CBD5E1] flex items-center justify-center shrink-0">
                        {!imgErrorIds[char.id] ? (
                          <img
                            src={char.url}
                            alt={char.name}
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setImgErrorIds((prev) => ({ ...prev, [char.id]: true }))
                            }
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <UserRound className="w-4 h-4 text-[#64748B]" />
                        )}
                      </span>
                      <span className="text-xs font-bold text-[#0F172A] max-w-[110px] truncate">
                        {char.name}
                      </span>
                      {isSelected && (
                        <Check className="w-3.5 h-3.5 text-[#B45309]" strokeWidth={3} />
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onDeleteCharacter(char.id)}
                      aria-label={`Delete saved portrait ${char.name}`}
                      className="p-1 text-[#64748B] hover:text-[#FF1744] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={2.25} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Optional Outfit / Style Change Input */}
          <div>
            <label
              htmlFor="character-outfit-prompt"
              className="flex items-center gap-1.5 text-xs font-extrabold text-[#0F172A] mb-1.5"
            >
              <Shirt className="w-3.5 h-3.5 text-[#B45309]" strokeWidth={2.5} />
              <span>Outfit Change Prompt (Optional — Face Stays Locked)</span>
            </label>
            <input
              id="character-outfit-prompt"
              type="text"
              maxLength={140}
              disabled={disabled}
              value={outfitPrompt}
              onChange={(e) => onOutfitPromptChange(e.target.value)}
              placeholder='e.g. "wearing a black hoodie" or "wearing a sharp navy blazer"'
              className="w-full rounded-xl border-2 border-[#E2E8F0] bg-[#F4F6F9] px-3.5 py-2.5 text-xs font-semibold text-[#0F172A] placeholder:text-[#94A3B8] focus:bg-white focus:border-[#FFAB00] focus:outline-none disabled:opacity-55"
            />
          </div>

          {uploadError && (
            <div
              role="alert"
              className="rounded-xl border-2 border-[#FF1744] bg-[#FFF1F3] px-3.5 py-2 text-xs font-bold text-[#B71C1C]"
            >
              {uploadError}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
