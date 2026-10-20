cask "kumadrive" do
  version "0.2.9"
  sha256 :no_check

  url "https://github.com/AkumaHalls/KumaDrive/releases/latest/download/KumaDrive_universal.dmg",
      verified: "github.com/AkumaHalls/KumaDrive/"
  name "KumaDrive"
  desc "Armazenamento em nuvem ilimitado alimentado pelo Telegram MTProto"
  homepage "https://github.com/AkumaHalls/KumaDrive"

  livecheck do
    url "https://github.com/AkumaHalls/KumaDrive/releases"
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "KumaDrive.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/KumaDrive.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/com.kumadrive.app",
    "~/Library/Caches/com.kumadrive.app",
    "~/Library/Preferences/com.kumadrive.app.plist",
    "~/Library/Saved Application State/com.kumadrive.app.savedState",
  ]
end
