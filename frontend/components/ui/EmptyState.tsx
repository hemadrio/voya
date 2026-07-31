import * as React from "react";
import { cn } from "@/lib/utils.js";
import { Button } from "./Button.js";

export interface EmptyStateProps {
  title: string;
  description?: string | undefined;
  icon?: React.ReactNode | undefined;
  action?: {
    label: string;
    onClick: () => void;
  } | undefined;
  className?: string | undefined;
}

function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-neutral-300 px-6 py-16 text-center",
        className,
      )}
    >
      {icon !== undefined && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-neutral-900">{title}</h3>
        {description !== undefined && (
          <p className="text-sm text-neutral-500">{description}</p>
        )}
      </div>
      {action !== undefined && (
        <Button variant="secondary" size="md" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export { EmptyState };
