from app.service import Service
import app.storage as store
from .nope import missing


def main():
    svc = Service()
    svc.create("ada")
    store.save(1)


if __name__ == "__main__":
    main()
