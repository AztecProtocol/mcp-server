use aztec::macros::aztec;

#[aztec]
pub contract DevelopmentToken {
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::Owned,
    };
    use balance_set::BalanceSet;

    #[storage]
    struct Storage<Context> {
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[initializer]
    #[external("private")]
    fn constructor(initial_supply: u128, owner: AztecAddress) {
        self.storage.balances.at(owner).add(initial_supply).deliver(MessageDelivery::onchain_constrained());
    }

    #[external("private")]
    fn transfer(amount: u128, recipient: AztecAddress) {
        self.storage.balances.at(self.msg_sender()).sub(amount).deliver(MessageDelivery::onchain_constrained());
        self.storage.balances.at(recipient).add(amount).deliver(MessageDelivery::onchain_constrained());
    }

    #[external("utility")]
    unconstrained fn balance_of(owner: AztecAddress) -> u128 {
        self.storage.balances.at(owner).balance_of()
    }
}
