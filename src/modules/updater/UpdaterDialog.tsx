import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/modules/i18n";
import { memo } from "react";
import { useUpdater } from "./useUpdater";

/**
 * "A newer release exists", with the way to it.
 *
 * There is no install button: this build ships no signing key, so the update is the release's page
 * and the installer on it. A dialog that said "install and restart" while the installer is a file
 * the person downloads would be describing a step it does not take.
 */
export const UpdaterDialog = memo(function UpdaterDialog() {
  const { status, install, dismiss } = useUpdater();
  const t = useT();

  if (status.kind !== "available") return null;

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {t("updater.available", { version: status.version })}
          </DialogTitle>
          <DialogDescription>
            {t("updater.manualHint", { version: status.version })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={dismiss}>
            {t("updater.later")}
          </Button>
          <Button size="sm" onClick={() => void install()}>
            {t("updater.downloadPackage")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
