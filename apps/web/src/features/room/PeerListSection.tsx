import type { ReactElement } from "react";
import type { VerifiedPeerInfo } from "@simpleim/peer-core";
import { StatusIcon } from "../../design-system/index.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export interface PeerListSectionProps {
  readonly peers: readonly VerifiedPeerInfo[];
}

export function PeerListSection({ peers }: PeerListSectionProps): ReactElement {
  const { t } = useI18n();

  return (
    <section className="side-section" aria-labelledby="peers-heading">
      <div className="side-section-header">
        <h2 id="peers-heading" className="side-section-title">
          {t("room.peers.heading")}
        </h2>
        <span className="side-section-count">{peers.length}</span>
      </div>

      <div data-testid="peer-list" className="side-list">
        {peers.length === 0 ? (
          <p className="side-empty" data-testid="peer-list-empty">
            {t("room.peers.empty")}
          </p>
        ) : (
          peers.map((peer) => (
            <div key={peer.peerId} className="peer-row">
              <div className="peer-row-main">
                <div className="peer-row-title">
                  <StatusIcon status="online" />
                  <span className="peer-row-name">{peer.displayName}</span>
                  <span className="msg-runtime-tag">
                    {peer.clientKind.toUpperCase()}
                  </span>
                </div>
                <span className="peer-row-handle">@{peer.username}</span>
              </div>

              <span className="peer-row-rtt">
                {peer.rttMs !== null ? `${Math.round(peer.rttMs)} ms` : "—"}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
