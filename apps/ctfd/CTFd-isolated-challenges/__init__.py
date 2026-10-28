from flask import Blueprint

from CTFd.models import Challenges
from CTFd.plugins import register_plugin_assets_directory
from CTFd.plugins.challenges import CHALLENGE_CLASSES, CTFdStandardChallenge
from CTFd.plugins.migrations import upgrade
from CTFd.utils.user import get_current_user
from CTFd.utils.security.signing import hmac

ASSETS = "/plugins/CTFd-isolated-challenges/assets/"

# challenges are rendered using the database model not the challenge class's read(), so we need a custom model and view to mutate connection_info
# https://github.com/CTFd/CTFd/issues/2377
class IsolatedChallengeModel(Challenges):
    __mapper_args__ = {"polymorphic_identity": "isolated"}

    @property
    def connection_info_isolated(self):
        # hmac of ciphertext pw is used in sessions, so probably good enough here. add user ID to prevent collisions
        # non-trivial to bruteforce, because middleware always spawns a session. need some challenge-specific way to check if it's another team's instance
        # https://chal.chals.example.com -> https://chal-1c31a9c1.chals.example.com
        user = get_current_user()
        return self.connection_info.replace(".", f"-{hmac(user.password)[:7]+hex(user.id)[2:]}.", 1)

class IsolatedChallenge(CTFdStandardChallenge):
    id = "isolated"  # Unique identifier used to register challenges
    name = "isolated"  # Name of a challenge type
    templates = {  # Templates used for each aspect of challenge editing & viewing
        "create": ASSETS + "create.html",  # create.html includes standard challenge type, so we need to override it
        "update": "/plugins/challenges/assets/update.html",
        "view": ASSETS + "view.html",
    }
    # Route at which files are accessible. This must be registered using register_plugin_assets_directory()
    route = ASSETS
    # Blueprint used to access the static_folder directory.
    blueprint = Blueprint(
        "isolated", __name__, template_folder="templates", static_folder="assets"
    )
    challenge_model = IsolatedChallengeModel

def load(app):
    upgrade(plugin_name="CTFd-isolated-challenges")
    CHALLENGE_CLASSES["isolated"] = IsolatedChallenge
    register_plugin_assets_directory(app, base_path=ASSETS)
