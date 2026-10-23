import { forwardRef, type ButtonHTMLAttributes, type MouseEvent } from "react";
import "./Button.css";

/**
 * Shared button. Every state is defined once in Button.css from the --ff-* state tokens:
 *
 *   default | hover | pressed (:active) | keyboard focus (:focus-visible) | disabled | loading
 *
 * - `disabled` is the native attribute: not focusable, not clickable, faded by --ff-disabled-opacity.
 * - `loading` keeps focus on the button (a disabled button drops focus, which is disorienting while a request runs),
 *   ignores clicks, shows a spinner and reports aria-busy to screen readers.
 * - Pointer clicks never show the focus ring; keyboard focus always does.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface BaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A request is running: stay focusable, ignore clicks, show a spinner. */
  loading?: boolean;
  type?: "button" | "submit" | "reset";
}

export interface ButtonProps extends BaseProps {
  /** Fill the container width. */
  block?: boolean;
}

/** An icon-only button must say what it does, so the label is required. */
export interface IconButtonProps extends BaseProps {
  label: string;
}

const join = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, block = false, type = "button", className, onClick, children, ...rest },
  ref,
) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={join("ff-btn", `ff-btn--${variant}`, `ff-btn--${size}`, block && "ff-btn--block", className)}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      data-loading={loading || undefined}
      onClick={handleClick}
    >
      {loading && <span className="ff-btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = "md", className, title, loading, children, ...rest },
  ref,
) {
  // While loading, the spinner replaces the icon: there is no room for both in a square button.
  return (
    <Button {...rest} ref={ref} variant={variant} size={size} loading={loading} className={join("ff-btn--icon", className)} aria-label={label} title={title ?? label}>
      {loading ? null : children}
    </Button>
  );
});
