"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * The source design expressed hover states with a `style-hover` attribute.
 * React has no inline pseudo-classes, so hover styles are merged over the base
 * style while the pointer is inside the element.
 */
type HoverProps = {
  style: CSSProperties;
  hoverStyle?: CSSProperties;
  children?: ReactNode;
};

export function HoverBox({
  style,
  hoverStyle,
  children,
  ...rest
}: HoverProps & React.HTMLAttributes<HTMLDivElement>) {
  const [on, setOn] = useState(false);
  return (
    <div
      {...rest}
      style={on && hoverStyle ? { ...style, ...hoverStyle } : style}
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
    >
      {children}
    </div>
  );
}

export function HoverButton({
  style,
  hoverStyle,
  children,
  ...rest
}: HoverProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [on, setOn] = useState(false);
  return (
    <button
      {...rest}
      style={on && hoverStyle ? { ...style, ...hoverStyle } : style}
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
    >
      {children}
    </button>
  );
}
