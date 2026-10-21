use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use token_contract::DevelopmentToken;

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let address = env.deploy("@token_contract/DevelopmentToken")
        .with_private_initializer(alice, DevelopmentToken::interface().constructor(1000, alice));
    (env, address, alice, bob)
}

#[test]
unconstrained fn test_initial_supply() {
    let (env, address, alice, bob) = setup();
    assert_eq(env.execute_utility(DevelopmentToken::at(address).balance_of(alice)), 1000);
    assert_eq(env.execute_utility(DevelopmentToken::at(address).balance_of(bob)), 0);
}

#[test]
unconstrained fn test_transfer() {
    let (mut env, address, alice, bob) = setup();
    env.call_private(alice, DevelopmentToken::at(address).transfer(25, bob));
    assert_eq(env.execute_utility(DevelopmentToken::at(address).balance_of(alice)), 975);
    assert_eq(env.execute_utility(DevelopmentToken::at(address).balance_of(bob)), 25);
}
