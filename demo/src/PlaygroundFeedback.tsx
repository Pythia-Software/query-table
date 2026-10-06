import { useEffect, useState } from "react";
import { Agentation } from "agentation";

export function PlaygroundFeedback() {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const updateContainer = () => {
      const dialogs = document.querySelectorAll<HTMLElement>('.qt-modal-surface[aria-modal="true"]');
      setPortalContainer(dialogs.item(dialogs.length - 1));
    };
    const observer = new MutationObserver(updateContainer);
    observer.observe(document.body, { childList: true });
    updateContainer();
    return () => observer.disconnect();
  }, []);

  return <Agentation appName="query-table playground" className="qt-demo-feedback" portalContainer={portalContainer} />;
}
