import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TradingDialogProps {
  title: string;
  description?: string;
  size?: "compact" | "wide";
  children: ReactNode;
  onClose(): void;
}

export function TradingDialog({
  title,
  description,
  size = "compact",
  children,
  onClose,
}: TradingDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!dialog.open) dialog.showModal();

    return () => {
      if (dialog.open) dialog.close();
      returnFocusRef.current?.focus({ preventScroll: true });
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`trading-dialog trading-dialog--${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="trading-dialog__surface">
        <header className="trading-dialog__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            type="button"
            className="trading-dialog__close"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            x
          </button>
        </header>
        <div className="trading-dialog__body">{children}</div>
      </div>
    </dialog>,
    document.body,
  );
}
