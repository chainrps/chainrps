// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockERC20
 * @notice 测试用 ERC20 代币合约，支持 mint/burn，用于本地和测试网调试
 * @dev mint 仅限 owner 调用，避免测试网被恶意增发；burn 任意持有者可销毁自己的余额
 */
// 测试用 ERC20 代币合约
contract MockERC20 {
    // 代币名称
    string public name;
    // 代币符号
    string public symbol;
    // 小数位数
    uint8 public decimals;
    // 总供应量
    uint256 public totalSupply;

    // 合约所有者
    address public owner;

    // 余额映射
    mapping(address => uint256) public balanceOf;
    // 授权额度映射
    mapping(address => mapping(address => uint256)) public allowance;

    // ---- EIP-2612 Permit 支持 ----
    // permit 防重放 nonce
    mapping(address => uint256) public nonces;
    // EIP-712 域分隔符
    bytes32 public DOMAIN_SEPARATOR;
    // EIP-2612 Permit 类型哈希
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );
    // EIP-712 Domain 类型哈希
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    // 转账事件
    event Transfer(address indexed from, address indexed to, uint256 value);
    // 授权事件
    event Approval(address indexed owner, address indexed spender, uint256 value);
    // 所有权转移事件
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    // 铸造事件
    event Mint(address indexed to, uint256 value);
    // 销毁事件
    event Burn(address indexed from, uint256 value);

    // 仅 owner 调用修饰器
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    // 构造函数 - 初始化代币信息
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        uint256 _initialSupply
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        totalSupply = _initialSupply;
        balanceOf[msg.sender] = _initialSupply;
        owner = msg.sender;
        emit Transfer(address(0), msg.sender, _initialSupply);
        emit OwnershipTransferred(address(0), msg.sender);

        // 初始化 EIP-712 域分隔符（用于 EIP-2612 permit）
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            _EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes(_name)),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // EIP-2612 Permit - 单交易授权（支持 ChainRPS permitDeposit 测试）
    /**
     * @notice EIP-2612 Permit - 单交易授权
     * @dev 通过 EIP-712 签名在单次交易中完成 approve，避免额外的 approve 交易
     * @param owner_ 代币持有者
     * @param spender 被授权者
     * @param value 授权金额
     * @param deadline 截止时间戳
     * @param v,r,s 签名分量
     */
    function permit(
        address owner_,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "Permit: expired deadline");

        bytes32 structHash = keccak256(abi.encode(
            PERMIT_TYPEHASH,
            owner_,
            spender,
            value,
            nonces[owner_]++,
            deadline
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == owner_, "Permit: invalid signature");

        allowance[owner_][spender] = value;
        emit Approval(owner_, spender, value);
    }

    // 转账 - 从调用者地址转出指定金额到目标地址
    function transfer(address to, uint256 value) external returns (bool) {
        require(to != address(0), "Zero address");
        require(balanceOf[msg.sender] >= value, "Insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    // 授权 - 允许指定地址花费调用者的代币
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    // 从授权地址转账 - 使用 allowance 额度从指定地址转出代币
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(from != address(0) && to != address(0), "Zero address");
        require(balanceOf[from] >= value, "Insufficient balance");
        require(allowance[from][msg.sender] >= value, "Insufficient allowance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        allowance[from][msg.sender] -= value;
        emit Transfer(from, to, value);
        return true;
    }

    // 铸造代币（仅 owner）
    /**
     * @notice 铸造代币（仅 owner）
     */
    function mint(address to, uint256 value) external onlyOwner {
        require(to != address(0), "Zero address");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
        emit Mint(to, value);
    }

    // 销毁调用者自己的代币
    /**
     * @notice 销毁调用者自己的代币
     */
    function burn(uint256 value) external {
        require(balanceOf[msg.sender] >= value, "Insufficient balance");
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
        emit Burn(msg.sender, value);
    }

    // 转移所有权
    /**
     * @notice 转移所有权
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}