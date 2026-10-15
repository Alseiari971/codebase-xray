import json
import requests
from .models import User
from . import storage


class Service:
    def create(self, name):
        user = User(name)
        storage.save(user)
        self.log(user)
        return json.dumps({"greeting": user.greet()})

    def log(self, user):
        print(user)


@staticmethod
def fetch(url):
    return requests.get(url)
