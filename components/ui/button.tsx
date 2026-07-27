import type { ComponentProps } from 'react'

import { cn } from '@/lib/cn'

// v1's four button variants, which its CSS expressed as `.btn.gold`, `.btn.outline`,
// `.btn.danger` and `.btn.ghost`. Same shapes, same intent — one component with props
// instead of a class matrix.

const VARIANTS = {
  gold: 'bg-gold text-gold-ink border-gold hover:bg-gold-hover',
  outline: 'bg-transparent text-ink-secondary border-line-strong hover:bg-overlay hover:border-ink-faint',
  danger: 'bg-critical text-ink border-critical hover:brightness-110',
  ghost: 'bg-transparent text-ink-muted border-transparent hover:text-ink-secondary hover:bg-raised',
} as const

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-[18px] py-3 text-[13px]',
} as const

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'className'> {
  variant?: keyof typeof VARIANTS
  size?: keyof typeof SIZES
  className?: string
  /** Stretch to the container. v1's `.btn` set `flex: 1` unconditionally, which surprised
   *  every caller that wanted an inline button; opt in instead. */
  block?: boolean
}

export function Button({
  variant = 'gold',
  size = 'md',
  block = false,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        'rounded-control border font-bold tracking-[0.3px] transition-all duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
    />
  )
}
