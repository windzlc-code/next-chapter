import { AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, duration: durationProp, ...props }) {
        const isDestructive = props.variant === "destructive";
        const duration =
          durationProp !== undefined
            ? durationProp
            : isDestructive
              ? Number.POSITIVE_INFINITY
              : 5000;

        if (isDestructive) {
          return (
            <Toast key={id} {...props} duration={duration}>
              <div className="flex min-w-0 flex-1 items-start gap-2.5 px-1 py-0.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400/80" />
                <div className="min-w-0 flex-1">
                  {title && (
                    <ToastTitle className="text-slate-100">{title}</ToastTitle>
                  )}
                  {description && (
                    <ToastDescription className="mt-0.5">{description}</ToastDescription>
                  )}
                </div>
              </div>
              {action}
              <ToastClose className="ml-1 mr-0.5" />
            </Toast>
          );
        }

        return (
          <Toast
            key={id}
            {...props}
            duration={duration}
            className={cn(props.className, "cursor-pointer select-none")}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              dismiss(id);
            }}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
