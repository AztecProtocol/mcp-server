use aztec::macros::aztec;

#[aztec]
pub contract Counter {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::Owned,
    };
    use balance_set::BalanceSet;

    #[storage]
    struct Storage<Context> {
        counters: Owned<BalanceSet<Context>, Context>,
    }

    #[initializer]
    #[external("private")]
    fn constructor(initial_value: u128, owner: AztecAddress) {
        // Delivers the note to the recipient onchain.
        // Without delivery, the recipient can't find or decrypt the note.
        self.storage.counters.at(owner).add(initial_value).deliver(
            MessageDelivery::onchain_unconstrained(),
        );
    }

    #[external("private")]
    fn increment(owner: AztecAddress) {
        self.storage.counters.at(owner).add(1).deliver(MessageDelivery::onchain_unconstrained());
    }

    #[external("utility")]
    unconstrained fn get_counter(owner: AztecAddress) -> u128 {
        self.storage.counters.at(owner).balance_of()
    }
}
