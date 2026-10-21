import { Search, X } from "lucide-react";
import { useRef } from "react";
import "./search-field.css";

export function SearchField({ label, value, onChange, placeholder = label, autoFocus = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  function clear() {
    onChange("");
    input.current?.focus();
  }
  return <div className="search-field clearable-search-field">
    <Search size={15} aria-hidden="true" />
    <input ref={input} autoFocus={autoFocus} aria-label={label} value={value} placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !value || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
      }} />
    <button type="button" className="search-field-clear" aria-label={`清空${label}`} title="清空搜索"
      disabled={!value} style={{ visibility: value ? undefined : "hidden" }} onClick={clear}><X size={14} /></button>
  </div>;
}
